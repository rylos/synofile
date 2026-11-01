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
    io::stdin().read_exact(&mut text)?;
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
    let meta = std::fs::metadata(path)?;
    if !force && stamp(&meta) != expected {
        return Err(ApiError::conflict(t!("il file è cambiato sul NAS da quando l'hai aperto", "the file changed on the NAS since you opened it")));
    }
    let own = meta.uid() == unsafe { libc::geteuid() };
    if own && meta.nlink() == 1 {
        // a new file beside it, renamed over it: never half written
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let tmp = path.with_file_name(format!(".{name}.synofile-edit"));
        let result = (|| -> io::Result<()> {
            let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
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
        // keeps its owner, ACL and links
        let mut f = std::fs::OpenOptions::new().write(true).truncate(true).open(path)?;
        f.write_all(text)?;
        f.sync_all()?;
    }
    reply(out, &json!({ "stamp": stamp(&std::fs::metadata(path)?) }))
}
