//! Bytes in and out through the browser: downloads (a file, with ranges
//! for players and PDF viewers; folders and selections as a tar stream),
//! and uploads in chunks that a dropped connection can resume.

use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
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

/// Largest chunk of an upload: the interface sends 16 MiB.
pub const MAX_CHUNK: u64 = 64 * 1024 * 1024;

pub fn upload_part(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!(".{name}.synofile-upload"))
}

#[derive(serde::Serialize)]
pub struct UploadState {
    pub received: u64,
    pub done: bool,
}

/// One chunk of an upload. The data goes into a hidden file beside the
/// target, renamed into place with the last chunk.
pub fn upload(req: &Request, dir: &Path, name: &str) -> Result<UploadState, ApiError> {
    let offset: u64 = req.param("offset").and_then(|v| v.parse().ok()).unwrap_or(0);
    let total: u64 = req.require("total")?.parse().map_err(|_| ApiError::bad_request("total"))?;
    let overwrite = req.param("overwrite") == Some("1");
    if req.length > MAX_CHUNK || offset + req.length > total {
        return Err(ApiError::bad_request(t!("blocco non valido", "invalid chunk")));
    }
    let target = dir.join(name);
    let part = upload_part(dir, name);
    let mut file = if offset == 0 {
        if !overwrite && fs::symlink_metadata(&target).is_ok() {
            return Err(ApiError::conflict(t!("esiste già", "already exists")));
        }
        OpenOptions::new().write(true).create(true).truncate(true).open(&part)?
    } else {
        let file = OpenOptions::new().write(true).open(&part).map_err(|_| ApiError::conflict(t!("upload da ricominciare", "the upload has to start again")))?;
        let have = file.metadata()?.len();
        if have != offset {
            return Err(ApiError::new(409, format!("offset {have}")));
        }
        file
    };
    file.seek(SeekFrom::Start(offset))?;
    let copied = io::copy(&mut io::stdin().lock().take(req.length), &mut file)?;
    if copied != req.length {
        return Err(ApiError::bad_request(t!("blocco incompleto", "incomplete chunk")));
    }
    let received = offset + copied;
    if received < total {
        return Ok(UploadState { received, done: false });
    }
    if let Some(mtime) = req.param("mtime").and_then(|m| m.parse::<i64>().ok()) {
        let times = [
            libc::timespec { tv_sec: 0, tv_nsec: libc::UTIME_OMIT },
            libc::timespec { tv_sec: mtime as _, tv_nsec: 0 },
        ];
        // SAFETY: an open descriptor and two timespecs
        unsafe { libc::futimens(std::os::fd::AsRawFd::as_raw_fd(&file), times.as_ptr()) };
    }
    drop(file);
    if overwrite {
        fs::rename(&part, &target)?;
    } else {
        rename_noreplace(&part, &target).map_err(|e| {
            let _ = fs::remove_file(&part);
            ApiError::from(e)
        })?;
    }
    Ok(UploadState { received, done: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

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
