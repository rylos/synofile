//! What the interface reads and the quick changes it makes, run in the CGI
//! process after it became the user.

use std::ffi::CString;
use std::fs::{self, Metadata};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::cgi::ApiError;

/// Synology keeps thumbnails and index data in these: never shown.
pub fn is_system_name(name: &str) -> bool {
    name == "@eaDir" || name.starts_with(".synofile-") || name.ends_with(".synofile-part") || name.ends_with(".synofile-upload")
}

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    /// d directory, f file, l symlink, o anything else
    pub kind: char,
    pub size: u64,
    pub mtime: i64,
    pub mode: u32,
    /// for a symlink: whether it points to a directory
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub link_dir: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub thumb: bool,
}

fn kind(meta: &Metadata) -> char {
    let t = meta.file_type();
    if t.is_dir() {
        'd'
    } else if t.is_file() {
        'f'
    } else if t.is_symlink() {
        'l'
    } else {
        'o'
    }
}

pub fn entry(path: &Path, name: String, meta: &Metadata) -> Entry {
    let kind = kind(meta);
    let link_dir = kind == 'l' && fs::metadata(path).is_ok_and(|m| m.is_dir());
    Entry { name, kind, size: if kind == 'd' { 0 } else { meta.len() }, mtime: meta.mtime(), mode: meta.mode() & 0o7777, link_dir, thumb: false }
}

#[derive(Serialize)]
pub struct Listing {
    pub entries: Vec<Entry>,
    pub writable: bool,
}

pub fn list(dir: &Path) -> Result<Listing, ApiError> {
    let meta = fs::metadata(dir)?;
    if !meta.is_dir() {
        return Err(ApiError::bad_request(t!("non è una cartella", "not a folder")));
    }
    let thumbs: Vec<std::ffi::OsString> =
        fs::read_dir(dir.join("@eaDir")).map(|d| d.flatten().map(|e| e.file_name()).collect()).unwrap_or_default();
    let mut entries = Vec::new();
    for item in fs::read_dir(dir)?.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        if is_system_name(&name) {
            continue;
        }
        let path = item.path();
        let Ok(meta) = fs::symlink_metadata(&path) else { continue };
        let mut e = entry(&path, name, &meta);
        e.thumb = e.kind == 'f' && thumbs.iter().any(|t| *t == item.file_name());
        entries.push(e);
    }
    Ok(Listing { entries, writable: access(dir, libc::W_OK | libc::X_OK) })
}

pub fn access(path: &Path, mode: i32) -> bool {
    let Ok(c) = CString::new(path.as_os_str().as_bytes()) else { return false };
    // SAFETY: valid C string
    unsafe { libc::access(c.as_ptr(), mode) == 0 }
}

/// The Synology thumbnail of a file, largest first up to `size`.
pub fn thumbnail(file: &Path, big: bool) -> Option<PathBuf> {
    let dir = file.parent()?.join("@eaDir").join(file.file_name()?);
    let names: &[&str] = if big {
        &["SYNOPHOTO_THUMB_XL.jpg", "SYNOPHOTO_THUMB_B.jpg", "SYNOPHOTO_THUMB_M.jpg"]
    } else {
        &["SYNOPHOTO_THUMB_M.jpg", "SYNOPHOTO_THUMB_SM.jpg", "SYNOPHOTO_THUMB_B.jpg", "SYNOPHOTO_THUMB_S.jpg"]
    };
    names.iter().map(|n| dir.join(n)).find(|p| p.is_file())
}

#[derive(Serialize)]
pub struct Details {
    pub name: String,
    pub kind: char,
    pub size: u64,
    pub mtime: i64,
    pub atime: i64,
    pub ctime: i64,
    pub mode: u32,
    pub owner: String,
    pub group: String,
    pub inode: u64,
    pub links: u64,
    pub target: Option<String>,
    pub readable: bool,
    pub writable: bool,
    pub device: u64,
}

pub fn details(path: &Path) -> Result<Details, ApiError> {
    let meta = fs::symlink_metadata(path)?;
    let target = meta.file_type().is_symlink().then(|| fs::read_link(path).map(|t| t.to_string_lossy().into_owned()).unwrap_or_default());
    Ok(Details {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        kind: kind(&meta),
        size: meta.len(),
        mtime: meta.mtime(),
        atime: meta.atime(),
        ctime: meta.ctime(),
        mode: meta.permissions().mode() & 0o7777,
        owner: crate::identity::names("/etc/passwd", meta.uid()).unwrap_or_else(|| meta.uid().to_string()),
        group: crate::identity::names("/etc/group", meta.gid()).unwrap_or_else(|| meta.gid().to_string()),
        inode: meta.ino(),
        links: meta.nlink(),
        target,
        readable: access(path, libc::R_OK),
        writable: access(path, libc::W_OK),
        device: meta.dev(),
    })
}

pub fn mkdir(path: &Path) -> Result<(), ApiError> {
    fs::create_dir(path).map_err(|e| {
        if e.kind() == io::ErrorKind::AlreadyExists { ApiError::conflict(t!("esiste già un elemento con questo nome", "an item with this name already exists")) } else { e.into() }
    })
}

/// Renames without ever replacing: renameat2 with RENAME_NOREPLACE, and a
/// plain check where the filesystem lacks it.
pub fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    let (Ok(a), Ok(b)) = (CString::new(from.as_os_str().as_bytes()), CString::new(to.as_os_str().as_bytes())) else {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    };
    const RENAME_NOREPLACE: libc::c_uint = 1;
    // SAFETY: valid C strings
    let rc = unsafe { libc::syscall(libc::SYS_renameat2, libc::AT_FDCWD, a.as_ptr(), libc::AT_FDCWD, b.as_ptr(), RENAME_NOREPLACE) };
    if rc == 0 {
        return Ok(());
    }
    let e = io::Error::last_os_error();
    match e.raw_os_error() {
        Some(libc::EINVAL) | Some(libc::ENOSYS) => {
            // a case-only rename on a case-insensitive name is still fine
            if fs::symlink_metadata(to).is_ok() && !same_file(from, to) {
                return Err(io::Error::from(io::ErrorKind::AlreadyExists));
            }
            fs::rename(from, to)
        }
        _ => Err(e),
    }
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
        _ => false,
    }
}

pub fn rename(from: &Path, to: &Path) -> Result<(), ApiError> {
    rename_noreplace(from, to).map_err(|e| {
        if e.kind() == io::ErrorKind::AlreadyExists { ApiError::conflict(t!("esiste già un elemento con questo nome", "an item with this name already exists")) } else { e.into() }
    })
}

#[derive(Serialize, Default)]
pub struct Usage {
    pub bytes: u64,
    pub files: u64,
    pub dirs: u64,
    pub unreadable: u64,
    /// stopped at the deadline: the numbers are a lower bound
    pub partial: bool,
}

pub fn usage(paths: &[PathBuf], budget: Duration) -> Usage {
    let deadline = Instant::now() + budget;
    let mut u = Usage::default();
    let mut stack: Vec<PathBuf> = paths.to_vec();
    while let Some(path) = stack.pop() {
        if Instant::now() > deadline {
            u.partial = true;
            break;
        }
        let Ok(meta) = fs::symlink_metadata(&path) else {
            u.unreadable += 1;
            continue;
        };
        if meta.is_dir() {
            u.dirs += 1;
            match fs::read_dir(&path) {
                Ok(rd) => stack.extend(rd.flatten().filter(|e| !is_system_name(&e.file_name().to_string_lossy())).map(|e| e.path())),
                Err(_) => u.unreadable += 1,
            }
        } else {
            u.files += 1;
            u.bytes += meta.len();
        }
    }
    u
}

#[derive(Serialize)]
pub struct Hit {
    pub dir: String,
    #[serde(flatten)]
    pub entry: Entry,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub hits: Vec<Hit>,
    pub scanned: u64,
    pub partial: bool,
}

/// What the search below a folder looks for: words that must all appear
/// in the name ("mkv" finds every .mkv), or a glob with * and ?. The fuzzy
/// matching is the interface's filter, on one folder.
pub struct Pattern {
    glob: Option<Vec<char>>,
    words: Vec<String>,
}

impl Pattern {
    pub fn new(query: &str) -> Self {
        let q = query.trim().to_lowercase();
        if q.contains('*') || q.contains('?') {
            Self { glob: Some(q.chars().collect()), words: Vec::new() }
        } else {
            Self { glob: None, words: q.split_whitespace().map(String::from).collect() }
        }
    }

    pub fn matches(&self, name: &str) -> bool {
        let name = name.to_lowercase();
        match &self.glob {
            Some(glob) => glob_match(glob, &name.chars().collect::<Vec<_>>()),
            None => !self.words.is_empty() && self.words.iter().all(|w| name.contains(w.as_str())),
        }
    }
}

fn glob_match(p: &[char], s: &[char]) -> bool {
    let (mut pi, mut si, mut star, mut mark) = (0, 0, None, 0);
    while si < s.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == s[si]) {
            pi += 1;
            si += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = si;
            pi += 1;
        } else if let Some(st) = star {
            pi = st + 1;
            mark += 1;
            si = mark;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

/// Walks below `root` breadth first, so near results come first, and
/// returns the matches with their directory relative to `root`.
pub fn search(root: &Path, pattern: &Pattern, limit: usize, budget: Duration) -> SearchResult {
    let deadline = Instant::now() + budget;
    let mut hits = Vec::new();
    let mut scanned = 0u64;
    let mut queue = std::collections::VecDeque::from([PathBuf::new()]);
    while let Some(rel) = queue.pop_front() {
        let Ok(rd) = fs::read_dir(root.join(&rel)) else { continue };
        for item in rd.flatten() {
            if (scanned % 256 == 0 && Instant::now() > deadline) || hits.len() >= limit {
                return SearchResult { hits, scanned, partial: true };
            }
            let name = item.file_name().to_string_lossy().into_owned();
            if is_system_name(&name) || name == crate::shares::RECYCLE || name == "#snapshot" {
                continue;
            }
            scanned += 1;
            let Ok(kind) = item.file_type() else { continue };
            if kind.is_dir() {
                queue.push_back(rel.join(&name));
            }
            if pattern.matches(&name) {
                let Ok(meta) = fs::symlink_metadata(item.path()) else { continue };
                hits.push(Hit { dir: rel.to_string_lossy().into_owned(), entry: entry(&item.path(), name, &meta) });
            }
        }
    }
    SearchResult { hits, scanned, partial: false }
}

/// Space on the filesystem holding `path`: (free for the user, total).
pub fn space(path: &Path) -> Option<(u64, u64)> {
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: zeroed out-parameter, valid C string
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    Some((st.f_bavail * st.f_frsize, st.f_blocks * st.f_frsize))
}

/// An I/O error in words the interface shows as they are.
pub fn describe(e: &io::Error) -> String {
    match e.raw_os_error() {
        Some(libc::EACCES) | Some(libc::EPERM) => t!("permesso negato", "permission denied").into(),
        Some(libc::ENOENT) => t!("non esiste più", "no longer exists").into(),
        Some(libc::EEXIST) => t!("esiste già", "already exists").into(),
        Some(libc::ENOSPC) => t!("spazio esaurito sul volume", "the volume is full").into(),
        Some(libc::EDQUOT) => t!("quota disco superata", "disk quota exceeded").into(),
        Some(libc::EROFS) => t!("il volume è in sola lettura", "the volume is read-only").into(),
        Some(libc::ENOTEMPTY) => t!("la cartella non è vuota", "the folder is not empty").into(),
        Some(libc::ENAMETOOLONG) => t!("nome troppo lungo", "name too long").into(),
        Some(libc::EISDIR) => t!("è una cartella", "is a folder").into(),
        Some(libc::ENOTDIR) => t!("non è una cartella", "not a folder").into(),
        Some(libc::EXDEV) => t!("volumi diversi", "different volumes").into(),
        Some(libc::EIO) => t!("errore di lettura o scrittura del disco", "disk read or write error").into(),
        Some(libc::EBUSY) => t!("in uso", "in use").into(),
        Some(libc::ELOOP) => t!("troppi collegamenti simbolici", "too many symbolic links").into(),
        _ => e.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns() {
        let p = Pattern::new("fattura 2026");
        assert!(p.matches("Fattura_luce_2026.pdf"));
        assert!(!p.matches("fattura 2025.pdf"));
        assert!(Pattern::new("mkv").matches("Il Padrino (1972).MKV"));
        assert!(!Pattern::new("mkv").matches("trailer.mp4"));
        let g = Pattern::new("*.JPG");
        assert!(g.matches("IMG_0001.jpg"));
        assert!(!g.matches("IMG_0001.jpeg"));
        assert!(Pattern::new("img_00??.*").matches("IMG_0042.heic"));
        assert!(!Pattern::new("  ").matches("x"));
    }

    #[test]
    fn rename_never_replaces() {
        let dir = std::env::temp_dir().join(format!("synofile-rename-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a"), "a").unwrap();
        fs::write(dir.join("b"), "b").unwrap();
        assert_eq!(rename_noreplace(&dir.join("a"), &dir.join("b")).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        rename_noreplace(&dir.join("a"), &dir.join("c")).unwrap();
        assert_eq!(fs::read_to_string(dir.join("c")).unwrap(), "a");
        fs::remove_dir_all(dir).unwrap();
    }
}
