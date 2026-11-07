//! Bytes in and out through the browser: downloads (a file, with ranges
//! for players and PDF viewers; folders and selections as a tar stream),
//! and uploads in chunks that a dropped connection can resume.

use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use crate::cgi::{self, ApiError, Request};
use crate::fsops::{is_system_name, rename_noreplace};

pub fn mime(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "heic" => "image/heic",
        "pdf" => "application/pdf",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "flac" => "audio/flac",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "txt" | "log" | "md" | "conf" | "ini" | "cfg" | "csv" | "tsv" | "json" | "yml" | "yaml" | "toml" | "xml"
        | "sh" | "py" | "rs" | "js" | "ts" | "css" | "c" | "h" | "cpp" | "go" | "java" | "sql" | "nfo" | "srt" => {
            "text/plain; charset=utf-8"
        }
        "html" | "htm" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// One file, whole or a range of it. `inline` shows it in the page (a
/// preview), otherwise the browser saves it.
pub fn send_file(out: &mut impl Write, req: &Request, path: &Path, inline: bool) -> Result<(), ApiError> {
    let meta = fs::metadata(path)?;
    if !meta.is_file() {
        return Err(ApiError::bad_request(t!("non è un file", "not a file")));
    }
    let mut file = File::open(path)?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let size = meta.len();
    let content_type = if inline { mime(&name) } else { "application/octet-stream" };
    let disposition = cgi::disposition(if inline { "inline" } else { "attachment" }, &name);
    let modified = meta.mtime().to_string();
    let (status, start, len) = match req.range.as_deref() {
        Some(range) => match cgi::parse_range(range, size) {
            Some((a, b)) => (206, a, b - a + 1),
            None => {
                let unsatisfied = format!("bytes */{size}");
                cgi::head(out, 416, &[("Content-Range", &unsatisfied)])?;
                return Ok(());
            }
        },
        None => (200, 0, size),
    };
    let length = len.to_string();
    let content_range = format!("bytes {start}-{}/{size}", start + len.saturating_sub(1));
    let mut headers = vec![
        ("Content-Type", content_type),
        ("Content-Disposition", disposition.as_str()),
        ("Content-Length", length.as_str()),
        ("Accept-Ranges", "bytes"),
        ("X-Mtime", modified.as_str()),
    ];
    if inline {
        // a preview never runs scripts, whatever the file holds
        headers.push(("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"));
    }
    if status == 206 {
        headers.push(("Content-Range", content_range.as_str()));
    }
    cgi::head(out, status, &headers)?;
    file.seek(SeekFrom::Start(start))?;
    io::copy(&mut file.take(len), out)?;
    Ok(())
}

/// The output of a command (a file out of an archive) as a download or a
/// preview. No ranges: the stream cannot seek.
pub fn send_command(out: &mut impl Write, mut cmd: std::process::Command, path: &str, size: u64, mtime: i64, inline: bool) -> Result<(), ApiError> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let content_type = if inline { mime(name) } else { "application/octet-stream" };
    let disposition = cgi::disposition(if inline { "inline" } else { "attachment" }, name);
    let length = size.to_string();
    let modified = mtime.to_string();
    let mut child = cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn()?;
    let mut headers = vec![
        ("Content-Type", content_type),
        ("Content-Disposition", disposition.as_str()),
        ("Content-Length", length.as_str()),
        ("X-Mtime", modified.as_str()),
    ];
    if inline {
        headers.push(("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"));
    }
    cgi::head(out, 200, &headers)?;
    let copied = io::copy(&mut child.stdout.take().unwrap().take(size), out);
    let _ = child.kill();
    let _ = child.wait();
    copied?;
    Ok(())
}

/// Several items as one zip stream, stored (no compression: the network is
/// the slow part), names relative to their folder.
pub fn send_zip(out: &mut impl Write, roots: &[PathBuf], filename: &str) -> Result<(), ApiError> {
    for root in roots {
        fs::symlink_metadata(root)?;
    }
    let disposition = cgi::disposition("attachment", filename);
    cgi::head(out, 200, &[("Content-Type", "application/zip"), ("Content-Disposition", &disposition)])?;
    let mut zip = crate::zip::ZipWriter::new(out);
    let mut none = |_n: u64| Ok(());
    for root in roots {
        let base = root.parent().unwrap_or(Path::new("/")).to_path_buf();
        let mut stack = vec![root.clone()];
        while let Some(path) = stack.pop() {
            let Ok(meta) = fs::symlink_metadata(&path) else { continue };
            let name = path.strip_prefix(&base).unwrap_or(&path).to_string_lossy().into_owned();
            if meta.is_dir() {
                zip.add_dir(&name, meta.mtime(), meta.mode())?;
                let Ok(rd) = fs::read_dir(&path) else { continue };
                let mut children: Vec<PathBuf> =
                    rd.flatten().filter(|e| !is_system_name(&e.file_name().to_string_lossy())).map(|e| e.path()).collect();
                children.sort_by(|a, b| b.cmp(a));
                stack.extend(children);
            } else if meta.is_file() {
                let Ok(mut file) = File::open(&path) else { continue };
                zip.add_file(&name, meta.mtime(), meta.mode(), &mut file, crate::zip::Level::Store, &mut none)?;
            } else if meta.file_type().is_symlink() {
                let link = fs::read_link(&path).map(|l| l.to_string_lossy().into_owned()).unwrap_or_default();
                zip.add_symlink(&name, meta.mtime(), &link)?;
            }
        }
    }
    zip.finish()?;
    Ok(())
}

/// Several items as one tar stream, names relative to their folder.
pub fn send_tar(out: &mut impl Write, roots: &[PathBuf], filename: &str) -> Result<(), ApiError> {
    for root in roots {
        fs::symlink_metadata(root)?;
    }
    let disposition = cgi::disposition("attachment", filename);
    cgi::head(out, 200, &[("Content-Type", "application/x-tar"), ("Content-Disposition", &disposition)])?;
    for root in roots {
        write_tree(root, out)?;
    }
    // end of archive: two zero blocks
    write_zeros(out, 1024)?;
    Ok(())
}

fn write_tree(root: &Path, out: &mut impl Write) -> io::Result<()> {
    let base = root.file_name().map(PathBuf::from).unwrap_or_else(|| PathBuf::from("cartella"));
    let mut stack = vec![(root.to_path_buf(), base)];
    while let Some((path, name)) = stack.pop() {
        let Ok(meta) = fs::symlink_metadata(&path) else { continue };
        let t = meta.file_type();
        let mut name = name.to_string_lossy().into_owned();
        if t.is_dir() {
            name.push('/');
            tar_header(out, &name, &meta, b'5', 0, "")?;
            let Ok(rd) = fs::read_dir(&path) else { continue };
            let mut children: Vec<_> =
                rd.flatten().map(|e| e.file_name()).filter(|n| !is_system_name(&n.to_string_lossy())).collect();
            // reverse, so popping visits them in order
            children.sort_by(|a, b| b.cmp(a));
            let parent = PathBuf::from(name.trim_end_matches('/'));
            stack.extend(children.into_iter().map(|c| (path.join(&c), parent.join(c))));
        } else if t.is_file() {
            let Ok(mut file) = File::open(&path) else { continue };
            tar_header(out, &name, &meta, b'0', meta.len(), "")?;
            // never write more or less than the header promised
            let copied = io::copy(&mut (&mut file).take(meta.len()), out)?;
            write_zeros(out, meta.len() - copied)?;
            write_zeros(out, padding(meta.len()))?;
        } else if t.is_symlink() {
            let link = fs::read_link(&path)?.to_string_lossy().into_owned();
            tar_header(out, &name, &meta, b'2', 0, &link)?;
        } else if t.is_fifo() || t.is_char_device() || t.is_block_device() || t.is_socket() {
            continue;
        }
    }
    Ok(())
}

fn padding(size: u64) -> u64 {
    (512 - size % 512) % 512
}

fn write_zeros(out: &mut impl Write, mut count: u64) -> io::Result<()> {
    let zeros = [0u8; 512];
    while count > 0 {
        let n = count.min(512) as usize;
        out.write_all(&zeros[..n])?;
        count -= n as u64;
    }
    Ok(())
}

fn octal(field: &mut [u8], value: u64) {
    let width = field.len() - 1;
    let text = format!("{value:0width$o}");
    let text = text.as_bytes();
    field[..width].copy_from_slice(&text[text.len() - width..]);
}

fn tar_header(out: &mut impl Write, name: &str, meta: &Metadata, typeflag: u8, size: u64, link: &str) -> io::Result<()> {
    if name.len() > 100 || link.len() > 100 {
        // GNU long name ('L') / long link ('K') records precede the entry
        for (flag, value) in [(b'L', name), (b'K', link)] {
            if value.len() > 100 {
                let mut record = value.as_bytes().to_vec();
                record.push(0);
                raw_header(out, "././@LongLink", 0o644, 0, 0, 0, flag, record.len() as u64, "")?;
                out.write_all(&record)?;
                write_zeros(out, padding(record.len() as u64))?;
            }
        }
    }
    let mtime = u64::try_from(meta.mtime()).unwrap_or(0);
    raw_header(out, name, meta.mode() & 0o7777, meta.uid(), meta.gid(), mtime, typeflag, size, link)
}

#[allow(clippy::too_many_arguments)]
fn raw_header(
    out: &mut impl Write,
    name: &str,
    mode: u32,
    uid: u32,
    gid: u32,
    mtime: u64,
    typeflag: u8,
    size: u64,
    link: &str,
) -> io::Result<()> {
    let mut h = [0u8; 512];
    let name = name.as_bytes();
    h[..name.len().min(100)].copy_from_slice(&name[..name.len().min(100)]);
    octal(&mut h[100..108], u64::from(mode));
    octal(&mut h[108..116], u64::from(uid));
    octal(&mut h[116..124], u64::from(gid));
    if size >= 0o77777777777 {
        // base-256 for files of 8 GiB and more (GNU extension)
        h[124] = 0x80;
        h[124 + 4..136].copy_from_slice(&size.to_be_bytes());
    } else {
        octal(&mut h[124..136], size);
    }
    octal(&mut h[136..148], mtime);
    h[156] = typeflag;
    let link = link.as_bytes();
    h[157..157 + link.len().min(100)].copy_from_slice(&link[..link.len().min(100)]);
    h[257..263].copy_from_slice(b"ustar\0");
    h[263..265].copy_from_slice(b"00");
    // checksum is computed with its own field set to spaces
    h[148..156].copy_from_slice(b"        ");
    let sum: u32 = h.iter().map(|&b| u32::from(b)).sum();
    let text = format!("{sum:06o}\0 ");
    h[148..156].copy_from_slice(text.as_bytes());
    out.write_all(&h)
}

/// Largest chunk of an upload: the interface sends 16 MiB, several at once.
pub const MAX_CHUNK: u64 = 64 * 1024 * 1024;
/// Suffix of the hidden file an upload is written into.
pub const UPLOAD_TAG: &str = "synofile-upload";

/// One chunk of an upload, as the query of `upload` describes it.
#[derive(Debug, Clone)]
pub struct Upload {
    pub offset: u64,
    pub length: u64,
    pub total: u64,
    /// seconds, given to the file when complete
    pub mtime: Option<i64>,
    /// replace the target if there is one
    pub overwrite: bool,
    /// replace the target only if older than `mtime`, skip the file otherwise
    pub newer: bool,
    /// the client's name for this attempt at the file
    pub id: String,
}

impl Upload {
    pub fn from_request(req: &Request) -> Result<Self, ApiError> {
        let number = |name: &str| -> Result<u64, ApiError> { req.require(name)?.parse().map_err(|_| ApiError::bad_request(format!("invalid {name}"))) };
        let up = Self {
            offset: req.param("offset").map_or(Ok(0), |_| number("offset"))?,
            length: req.length,
            total: number("total")?,
            mtime: req.param("mtime").and_then(|m| m.parse().ok()),
            overwrite: req.param("overwrite") == Some("1"),
            newer: req.param("newer") == Some("1"),
            id: upload_id(req)?,
        };
        up.check()?;
        Ok(up)
    }

    fn check(&self) -> Result<(), ApiError> {
        let end = self.offset.checked_add(self.length);
        let empty = self.length == 0 && self.total != 0;
        if self.length > MAX_CHUNK || empty || end.is_none_or(|end| end > self.total) {
            return Err(ApiError::bad_request(t!("blocco non valido", "invalid chunk")));
        }
        if self.newer && self.mtime.is_none() {
            return Err(ApiError::bad_request("newer without mtime"));
        }
        Ok(())
    }

    fn end(&self) -> u64 {
        self.offset + self.length
    }

    fn is_last(&self) -> bool {
        self.end() == self.total
    }

    fn replaces(&self) -> bool {
        self.overwrite || self.newer
    }
}

/// The `id` of an upload request: 8 to 32 of [0-9a-z], so it is safe in a
/// file name.
pub fn upload_id(req: &Request) -> Result<String, ApiError> {
    let id = req.require("id")?;
    if (8..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase()) {
        Ok(id.to_string())
    } else {
        Err(ApiError::bad_request("invalid upload id"))
    }
}

/// The hidden name an upload of `name` is written under:
/// `.{name}.{id}.synofile-upload`, within the 255 bytes of a name.
pub fn upload_part_name(name: &str, id: &str) -> String {
    crate::names::part_name(name, &format!("{id}.{UPLOAD_TAG}"))
}

/// Whether a name is an upload's hidden file.
fn is_upload_part(name: &[u8]) -> bool {
    name.starts_with(b".") && name.ends_with(format!(".{UPLOAD_TAG}").as_bytes())
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct UploadState {
    pub received: u64,
    pub done: bool,
    /// `newer`: the target was already as recent, nothing written
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub skipped: bool,
}

/// What is at the target's name.
#[derive(Debug, Clone, Copy)]
pub struct Existing {
    pub dir: bool,
    pub file: bool,
    pub size: u64,
    pub mtime: i64,
}

/// Where an upload goes: a folder of the NAS or of a remote server. The
/// rules of an upload (`receive`) are the same for both.
pub trait UploadStore {
    /// What is at the target's name, if anything.
    fn target(&self) -> io::Result<Option<Existing>>;
    /// Writes `length` bytes of `body` into the hidden file from `at` on,
    /// and says how many there were. `create`: the first chunk, which makes
    /// the file if missing (never emptying it: a chunk sent again must not
    /// lose the others). `None`: the file is not there.
    fn write(&mut self, create: bool, at: u64, body: &mut dyn Read, length: u64) -> io::Result<Option<u64>>;
    /// Whether the hidden file holds all `total` bytes.
    fn complete(&self, total: u64) -> io::Result<bool>;
    fn set_mtime(&self, mtime: i64);
    /// Renames the hidden file to the target, over it if `replace`.
    fn commit(&self, replace: bool) -> io::Result<()>;
    fn remove_part(&self);
    /// Removes the hidden files of uploads abandoned beside it.
    fn sweep(&self);
}

/// One chunk of an upload. The data goes into a hidden file beside the
/// target, renamed into place with the last chunk. The first chunk creates
/// the file; the ones between may come in any order, at once (each writes
/// its own range); the interface sends the last one when all the others
/// are in. The last one sent again after it went through is answered done.
pub fn receive(store: &mut impl UploadStore, up: &Upload, body: &mut dyn Read) -> Result<UploadState, ApiError> {
    if up.offset == 0 {
        if let Some(t) = store.target()? {
            if t.dir {
                return Err(ApiError::conflict(t!("è una cartella", "is a folder")));
            }
            // a file of one chunk sent again because the answer was lost:
            // the same size and time is the one that just arrived
            if !up.overwrite && up.is_last() && t.file && t.size == up.total && up.mtime == Some(t.mtime) {
                return Ok(UploadState { received: up.total, done: true, skipped: false });
            }
            if up.newer && up.mtime.is_some_and(|m| t.mtime >= m) {
                return Ok(UploadState { received: 0, done: true, skipped: true });
            }
            if !up.replaces() {
                return Err(ApiError::conflict(t!("esiste già", "already exists")));
            }
        }
        // only a file of several chunks leaves a hidden file when cut
        // short: a folder of small files is not listed again for each
        if !up.is_last() {
            store.sweep();
        }
    }
    let Some(copied) = store.write(up.offset == 0, up.offset, body, up.length)? else {
        if up.is_last() && store.target()?.is_some_and(|t| t.file && t.size == up.total) {
            return Ok(UploadState { received: up.total, done: true, skipped: false });
        }
        return Err(ApiError::conflict(t!("upload da ricominciare", "the upload has to start again")));
    };
    if copied != up.length {
        return Err(ApiError::bad_request(t!("blocco incompleto", "incomplete chunk")));
    }
    if !up.is_last() {
        return Ok(UploadState { received: up.end(), done: false, skipped: false });
    }
    if !store.complete(up.total)? {
        return Err(ApiError::conflict(t!("blocchi mancanti", "missing chunks")));
    }
    if let Some(mtime) = up.mtime {
        store.set_mtime(mtime);
    }
    store.commit(up.replaces()).map_err(|e| {
        store.remove_part();
        if e.kind() == io::ErrorKind::AlreadyExists { ApiError::conflict(t!("esiste già", "already exists")) } else { ApiError::from(e) }
    })?;
    Ok(UploadState { received: up.total, done: true, skipped: false })
}

/// An upload into a folder of the NAS.
pub struct LocalUpload {
    dir: PathBuf,
    target: PathBuf,
    part: PathBuf,
}

impl LocalUpload {
    pub fn new(dir: &Path, name: &str, id: &str) -> Self {
        Self { dir: dir.to_path_buf(), target: dir.join(name), part: dir.join(upload_part_name(name, id)) }
    }

    pub fn part(&self) -> &Path {
        &self.part
    }

    /// Removes the hidden files of uploads abandoned as of `now`.
    fn sweep_at(&self, now: std::time::SystemTime) {
        let Ok(entries) = fs::read_dir(&self.dir) else { return };
        for e in entries.flatten() {
            if !is_upload_part(e.file_name().as_encoded_bytes()) {
                continue;
            }
            if let Ok(m) = e.metadata()
                && m.is_file()
                && crate::names::abandoned(&m, now)
            {
                let _ = fs::remove_file(e.path());
            }
        }
    }

    /// The hidden file, never through a symlink, and only a plain file.
    fn open_part(&self, create: bool) -> io::Result<Option<File>> {
        let file = match OpenOptions::new().write(true).create(create).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&self.part) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound && !create => return Ok(None),
            Err(e) => return Err(e),
        };
        if !file.metadata()?.is_file() {
            return Err(io::Error::from_raw_os_error(libc::EINVAL));
        }
        Ok(Some(file))
    }
}

impl UploadStore for LocalUpload {
    fn target(&self) -> io::Result<Option<Existing>> {
        match fs::symlink_metadata(&self.target) {
            Ok(m) => Ok(Some(Existing { dir: m.is_dir(), file: m.is_file(), size: m.len(), mtime: m.mtime() })),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn write(&mut self, create: bool, at: u64, body: &mut dyn Read, length: u64) -> io::Result<Option<u64>> {
        let Some(mut file) = self.open_part(create)? else { return Ok(None) };
        file.seek(SeekFrom::Start(at))?;
        // in 1 MiB reads: a chunk is 16 MiB, and the body comes through a pipe
        Ok(Some(io::copy(&mut io::BufReader::with_capacity(1 << 20, body.take(length)), &mut file)?))
    }

    fn complete(&self, total: u64) -> io::Result<bool> {
        let Some(file) = self.open_part(false)? else { return Ok(false) };
        if file.metadata()?.len() != total {
            return Ok(false);
        }
        if total == 0 {
            return Ok(true);
        }
        // a chunk that never came is a hole in the file
        // SAFETY: an open descriptor
        let hole = unsafe { libc::lseek(std::os::fd::AsRawFd::as_raw_fd(&file), 0, libc::SEEK_HOLE) };
        if hole < 0 {
            let e = io::Error::last_os_error();
            // a file system without SEEK_HOLE: the size has to do
            return if e.raw_os_error() == Some(libc::EINVAL) { Ok(true) } else { Err(e) };
        }
        Ok(hole as u64 >= total)
    }

    fn set_mtime(&self, mtime: i64) {
        let Ok(path) = std::ffi::CString::new(self.part.as_os_str().as_encoded_bytes()) else { return };
        let times = [libc::timespec { tv_sec: 0, tv_nsec: libc::UTIME_OMIT }, libc::timespec { tv_sec: mtime as _, tv_nsec: 0 }];
        // SAFETY: a valid C string and two timespecs
        unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), libc::AT_SYMLINK_NOFOLLOW) };
    }

    fn commit(&self, replace: bool) -> io::Result<()> {
        if replace { fs::rename(&self.part, &self.target) } else { rename_noreplace(&self.part, &self.target) }
    }

    fn remove_part(&self) {
        let _ = fs::remove_file(&self.part);
    }

    fn sweep(&self) {
        self.sweep_at(std::time::SystemTime::now());
    }
}

/// One chunk of an upload into a folder of the NAS, the body on stdin.
pub fn upload(req: &Request, dir: &Path, name: &str) -> Result<UploadState, ApiError> {
    let up = Upload::from_request(req)?;
    receive(&mut LocalUpload::new(dir, name, &up.id), &up, &mut crate::cgi::body())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn tempdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("synofile-up-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn chunk(offset: u64, length: u64, total: u64) -> Upload {
        Upload { offset, length, total, mtime: Some(1_700_000_000), overwrite: false, newer: false, id: "abcd1234".into() }
    }

    fn send(dir: &Path, name: &str, up: &Upload, data: &[u8]) -> Result<UploadState, ApiError> {
        let mut body = io::Cursor::new(data[up.offset as usize..(up.offset + up.length) as usize].to_vec());
        receive(&mut LocalUpload::new(dir, name, &up.id), up, &mut body)
    }

    fn parts(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| is_upload_part(n.as_bytes())).collect();
        v.sort();
        v
    }

    #[test]
    fn upload_in_any_order_and_idempotent() {
        let dir = tempdir("order");
        let data: Vec<u8> = (0..40u32).map(|i| i as u8).collect();
        // chunk 0, then 2 before 1, then the last
        assert_eq!(send(&dir, "f.bin", &chunk(0, 10, 40), &data).unwrap(), UploadState { received: 10, done: false, skipped: false });
        // the first chunk again (a retry) does not empty the file
        send(&dir, "f.bin", &chunk(20, 10, 40), &data).unwrap();
        send(&dir, "f.bin", &chunk(0, 10, 40), &data).unwrap();
        send(&dir, "f.bin", &chunk(10, 10, 40), &data).unwrap();
        assert_eq!(parts(&dir), vec![".f.bin.abcd1234.synofile-upload"]);
        let done = send(&dir, "f.bin", &chunk(30, 10, 40), &data).unwrap();
        assert_eq!(done, UploadState { received: 40, done: true, skipped: false });
        assert_eq!(fs::read(dir.join("f.bin")).unwrap(), data);
        assert_eq!(fs::metadata(dir.join("f.bin")).unwrap().mtime(), 1_700_000_000);
        assert!(parts(&dir).is_empty());
        // the last chunk sent again: done, not "start again"
        assert_eq!(send(&dir, "f.bin", &chunk(30, 10, 40), &data).unwrap(), done);
        // a chunk in between, with the file gone, has to start again
        assert_eq!(send(&dir, "f.bin", &chunk(10, 10, 40), &data).unwrap_err().status, 409);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn single_chunk_sent_again_is_done() {
        let dir = tempdir("single");
        let data = b"hello".to_vec();
        let up = chunk(0, 5, 5);
        assert!(send(&dir, "s.txt", &up, &data).unwrap().done);
        // the answer was lost: the same chunk again is not "already exists"
        assert!(send(&dir, "s.txt", &up, &data).unwrap().done);
        // another file with that name still is
        let other = Upload { mtime: Some(1_600_000_000), ..chunk(0, 5, 5) };
        assert_eq!(send(&dir, "s.txt", &other, &data).unwrap_err().status, 409);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn upload_refuses_missing_chunks() {
        let dir = tempdir("holes");
        let data = vec![7u8; 3 * 8192];
        send(&dir, "h.bin", &chunk(0, 8192, 3 * 8192), &data).unwrap();
        // the middle chunk never came: the size is right, the hole shows
        let err = send(&dir, "h.bin", &chunk(2 * 8192, 8192, 3 * 8192), &data).unwrap_err();
        assert_eq!(err.status, 409);
        assert!(!dir.join("h.bin").exists());
        // it can still come, then the last again
        send(&dir, "h.bin", &chunk(8192, 8192, 3 * 8192), &data).unwrap();
        assert!(send(&dir, "h.bin", &chunk(2 * 8192, 8192, 3 * 8192), &data).unwrap().done);
        assert_eq!(fs::read(dir.join("h.bin")).unwrap(), data);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn upload_conflicts_and_newer() {
        let dir = tempdir("newer");
        let data = b"new content".to_vec();
        let len = data.len() as u64;
        fs::write(dir.join("a.txt"), "old").unwrap();
        // neither overwrite nor newer: refused
        assert_eq!(send(&dir, "a.txt", &chunk(0, len, len), &data).unwrap_err().status, 409);
        // newer, the file on the NAS more recent: skipped, nothing written
        let mut up = chunk(0, len, len);
        up.newer = true;
        up.mtime = Some(i64::MIN / 2);
        assert_eq!(send(&dir, "a.txt", &up, &data).unwrap(), UploadState { received: 0, done: true, skipped: true });
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "old");
        assert!(parts(&dir).is_empty());
        // newer, the file on the NAS older: replaced
        up.mtime = Some(i64::from(i32::MAX));
        assert!(send(&dir, "a.txt", &up, &data).unwrap().done);
        assert_eq!(fs::read(dir.join("a.txt")).unwrap(), data);
        // overwrite
        let mut up = chunk(0, 3, 3);
        up.overwrite = true;
        assert!(send(&dir, "a.txt", &up, b"xyz").unwrap().done);
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "xyz");
        // a folder is never replaced
        fs::create_dir(dir.join("d")).unwrap();
        assert_eq!(send(&dir, "d", &up, b"xyz").unwrap_err().status, 409);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn upload_of_an_empty_file() {
        let dir = tempdir("empty");
        assert!(send(&dir, "e", &chunk(0, 0, 0), b"").unwrap().done);
        assert_eq!(fs::metadata(dir.join("e")).unwrap().len(), 0);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn upload_never_writes_through_a_symlink() {
        let dir = tempdir("link");
        fs::write(dir.join("victim"), "keep").unwrap();
        let up = chunk(0, 4, 8);
        std::os::unix::fs::symlink(dir.join("victim"), dir.join(upload_part_name("x", &up.id))).unwrap();
        assert!(send(&dir, "x", &up, b"evil....").is_err());
        assert_eq!(fs::read_to_string(dir.join("victim")).unwrap(), "keep");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn upload_with_a_long_name() {
        let dir = tempdir("long");
        let name = "è".repeat(127); // 254 bytes, the longest even count
        let data = vec![1u8; 20];
        send(&dir, &name, &chunk(0, 10, 20), &data).unwrap();
        let p = parts(&dir);
        assert_eq!(p.len(), 1);
        assert!(p[0].len() <= 255 && p[0].ends_with(".abcd1234.synofile-upload"));
        assert!(send(&dir, &name, &chunk(10, 10, 20), &data).unwrap().done);
        assert_eq!(fs::read(dir.join(&name)).unwrap(), data);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn upload_sweeps_abandoned_parts() {
        let dir = tempdir("sweep");
        let old = dir.join(".gone.zzzz9999.synofile-upload");
        let legacy = dir.join(".legacy.synofile-upload");
        let fresh = dir.join(".busy.yyyy8888.synofile-upload");
        for p in [&old, &legacy, &fresh] {
            fs::write(p, "x").unwrap();
        }
        // a file just written is not abandoned, even with an old mtime
        let two_days = std::time::SystemTime::now() - std::time::Duration::from_secs(48 * 3600);
        File::options().write(true).open(&fresh).unwrap().set_modified(two_days).unwrap();
        let data = vec![0u8; 20];
        send(&dir, "n", &chunk(0, 10, 20), &data).unwrap();
        assert!(old.exists() && legacy.exists() && fresh.exists());
        // two days on, they all are; the upload under way is not touched by its own sweep
        let store = LocalUpload::new(&dir, "x", "abcd1234");
        store.sweep_at(std::time::SystemTime::now() + std::time::Duration::from_secs(48 * 3600));
        assert!(!old.exists() && !legacy.exists() && !fresh.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn upload_checks_its_parameters() {
        assert!(chunk(0, 10, 20).check().is_ok());
        assert!(chunk(15, 10, 20).check().is_err());
        assert!(chunk(u64::MAX, 10, 20).check().is_err());
        assert!(chunk(0, MAX_CHUNK + 1, u64::MAX).check().is_err());
        assert!(chunk(5, 0, 20).check().is_err());
        let mut up = chunk(0, 10, 20);
        up.newer = true;
        up.mtime = None;
        assert!(up.check().is_err());
        assert_eq!(upload_part_name("a.txt", "abcd1234"), ".a.txt.abcd1234.synofile-upload");
        assert!(is_upload_part(b".a.txt.abcd1234.synofile-upload"));
        assert!(!is_upload_part(b"a.synofile-upload"));
    }

    #[test]
    fn tar_unpacks_with_gnu_tar() {
        let dir = std::env::temp_dir().join(format!("synofile-tar-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let root = dir.join("Foto");
        fs::create_dir_all(root.join("2026").join("@eaDir")).unwrap();
        fs::write(root.join("2026/a.txt"), "ciao").unwrap();
        fs::write(root.join("2026/@eaDir/x"), "thumb").unwrap();
        fs::write(dir.join("b.txt"), "b".repeat(700)).unwrap();
        let archive = dir.join("out.tar");
        {
            let mut f = File::create(&archive).unwrap();
            for r in [root.clone(), dir.join("b.txt")] {
                write_tree(&r, &mut f).unwrap();
            }
            write_zeros(&mut f, 1024).unwrap();
        }
        let unpack = dir.join("unpack");
        fs::create_dir(&unpack).unwrap();
        let status = Command::new("tar").arg("-xf").arg(&archive).arg("-C").arg(&unpack).status().unwrap();
        assert!(status.success());
        assert_eq!(fs::read_to_string(unpack.join("Foto/2026/a.txt")).unwrap(), "ciao");
        assert_eq!(fs::read_to_string(unpack.join("b.txt")).unwrap().len(), 700);
        assert!(!unpack.join("Foto/2026/@eaDir").exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
