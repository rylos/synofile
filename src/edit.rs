//! The text editor's side on the NAS: a file read whole, and saved back
//! only if nobody changed it meanwhile, keeping its permissions and owner.

use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

use serde_json::json;

use crate::cgi::{self, ApiError, Request};

fn reply(out: &mut impl Write, value: &impl serde::Serialize) -> Result<(), ApiError> {
    cgi::json(out, 200, value)?;
    Ok(())
}

/// The largest file the editor opens.
pub const MAX: u64 = 8 * 1024 * 1024;

/// What a file is now, to tell whether it changed: mtime with nanoseconds,
/// and size.
fn stamp(meta: &std::fs::Metadata) -> String {
    format!("{}.{:09}-{}", meta.mtime(), meta.mtime_nsec(), meta.len())
}

/// The bytes as text the editor can give back unchanged: UTF-8, no NUL.
pub fn as_text(bytes: Vec<u8>) -> Result<String, ApiError> {
    if bytes.contains(&0) {
        return Err(ApiError::new(415, t!("non è un file di testo", "not a text file")));
    }
    String::from_utf8(bytes).map_err(|_| ApiError::new(415, t!("il file non è testo UTF-8: l'editor lo rovinerebbe", "the file is not UTF-8 text: the editor would spoil it")))
}

pub fn too_big() -> ApiError {
    ApiError::new(413, t!("file troppo grande per l'editor (massimo 8 MB)", "file too large for the editor (8 MB at most)"))
}

/// The body of a save: the whole text.
pub fn body(req: &Request) -> Result<Vec<u8>, ApiError> {
    if req.length > MAX {
        return Err(too_big());
    }
    let mut text = vec![0; req.length as usize];
    crate::cgi::body().read_exact(&mut text)?;
    String::from_utf8(text).map(String::into_bytes).map_err(|_| ApiError::bad_request("UTF-8"))
}

pub fn open(out: &mut impl Write, path: &Path) -> Result<(), ApiError> {
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Err(ApiError::bad_request(t!("non è un file", "not a file")));
    }
    if meta.len() > MAX {
        return Err(too_big());
    }
    let text = as_text(std::fs::read(path)?)?;
    let writable = nix_access(path);
    reply(out, &json!({ "text": text, "stamp": stamp(&meta), "writable": writable }))
}

fn nix_access(path: &Path) -> bool {
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()) else { return false };
    unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
}

/// Saves `text` over `path`. `stamp`: what the file was when opened; a
/// different one now is a conflict, unless `force`.
pub fn save(out: &mut impl Write, path: &Path, text: &[u8], expected: &str, force: bool) -> Result<(), ApiError> {
    let stamp = write(path, text, expected, force)?;
    reply(out, &json!({ "stamp": stamp }))
}

/// The saving itself, and the file's new stamp.
fn write(path: &Path, text: &[u8], expected: &str, force: bool) -> Result<String, ApiError> {
    // a symlink stays one: the file it points to is the one saved
    let real = if std::fs::symlink_metadata(path)?.file_type().is_symlink() { std::fs::canonicalize(path)? } else { path.to_path_buf() };
    let path = real.as_path();
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Err(ApiError::bad_request(t!("non è un file", "not a file")));
    }
    if !force && stamp(&meta) != expected {
        return Err(ApiError::conflict(t!("il file è cambiato sul NAS da quando l'hai aperto", "the file changed on the NAS since you opened it")));
    }
    // SAFETY: a plain getter
    let own = meta.uid() == unsafe { libc::geteuid() };
    if own && meta.nlink() == 1 {
        // a new file beside it, renamed over it: never half written
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let tmp = path.with_file_name(crate::names::part_name(&name, "synofile-edit"));
        // a leftover of a save cut short (or anything planted there) goes first
        let _ = std::fs::remove_file(&tmp);
        let result = (|| -> io::Result<()> {
            let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&tmp)?;
            f.write_all(text)?;
            f.set_permissions(std::fs::Permissions::from_mode(meta.mode() & 0o7777))?;
            let _ = std::os::unix::fs::fchown(&f, None, Some(meta.gid()));
            f.sync_all()?;
            std::fs::rename(&tmp, path)
        })();
        if let Err(e) = result {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.into());
        }
    } else {
        // someone else's file (or hard-linked): written in place, so it
        // keeps its owner, ACL and links. Cut to size only after: a full
        // disk leaves the old text partly overwritten, never an empty file.
        let mut f = std::fs::OpenOptions::new().write(true).custom_flags(libc::O_CLOEXEC).open(path)?;
        f.write_all(text)?;
        f.set_len(text.len() as u64)?;
        f.sync_all()?;
    }
    Ok(stamp(&std::fs::metadata(path)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("synofile-edit-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn stamp_of(p: &Path) -> String {
        stamp(&std::fs::metadata(p).unwrap())
    }

    #[test]
    fn saves_and_detects_conflicts() {
        let dir = tempdir("save");
        let f = dir.join("a.txt");
        std::fs::write(&f, "one").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o640)).unwrap();
        let s = stamp_of(&f);
        // another size: two writes within one tick of the file system clock
        // share an mtime, and the stamp tells them apart by the size alone
        let new = write(&f, b"second", &s, false).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "second");
        assert_eq!(std::fs::metadata(&f).unwrap().mode() & 0o777, 0o640);
        assert_eq!(new, stamp_of(&f));
        // the old stamp is a conflict now, unless forced
        assert_eq!(write(&f, b"three", &s, false).unwrap_err().status, 409);
        write(&f, b"three", &s, true).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "three");
        // only the file is left in the folder
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_symlink_stays_a_symlink() {
        let dir = tempdir("link");
        let real = dir.join("real.txt");
        let link = dir.join("link.txt");
        std::fs::write(&real, "old").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        write(&link, b"new", &stamp_of(&link), false).unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "new");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_planted_temporary_file_is_not_followed() {
        let dir = tempdir("plant");
        let f = dir.join("a.txt");
        let victim = dir.join("victim");
        std::fs::write(&f, "text").unwrap();
        std::fs::write(&victim, "keep").unwrap();
        std::os::unix::fs::symlink(&victim, dir.join(".a.txt.synofile-edit")).unwrap();
        write(&f, b"saved", &stamp_of(&f), false).unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "saved");
        assert!(!dir.join(".a.txt.synofile-edit").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn in_place_shortens_after_writing() {
        let dir = tempdir("inplace");
        let f = dir.join("a.txt");
        let other = dir.join("b.txt");
        std::fs::write(&f, "a long original text").unwrap();
        // a hard link forces the in-place path
        std::fs::hard_link(&f, &other).unwrap();
        write(&f, b"short", &stamp_of(&f), false).unwrap();
        assert_eq!(std::fs::read_to_string(&other).unwrap(), "short");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
