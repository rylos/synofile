//! Archives opened like folders: zip, 7z, rar and tar (plain or compressed)
//! are listed with the tools DSM ships (7z, unrar, GNU tar) and single
//! members are streamed out of them. Read-only: nothing is ever written
//! into an archive.

use crate::cgi::ApiError;
use crate::fsops::Entry;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    /// anything 7z reads directly: zip, 7z, jar, iso, cab
    SevenZip,
    Rar,
    /// tar, with the flag GNU tar needs for its compression
    Tar(Option<&'static str>),
}

/// The format of an archive that can be opened as a folder, from its name.
pub fn format(name: &str) -> Option<Format> {
    let n = name.to_ascii_lowercase();
    let tar = [(".tar", None), (".tar.gz", Some("-z")), (".tgz", Some("-z")), (".tar.bz2", Some("-j")), (".tbz2", Some("-j")), (".tbz", Some("-j")), (".tar.xz", Some("-J")), (".txz", Some("-J")), (".tar.zst", Some("--zstd"))];
    if let Some((_, flag)) = tar.iter().find(|(ext, _)| n.ends_with(ext)) {
        return Some(Format::Tar(*flag));
    }
    if n.ends_with(".rar") {
        return Some(Format::Rar);
    }
    [".zip", ".7z", ".jar", ".iso", ".cab"].iter().any(|e| n.ends_with(e)).then_some(Format::SevenZip)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Member {
    /// normalised: no leading "./" or "/", no trailing "/"
    pub path: String,
    /// the name exactly as stored, for the tools
    pub raw: String,
    pub dir: bool,
    pub link: bool,
    pub size: u64,
    pub mtime: i64,
    pub mode: u32,
}

/// Where `real` falls inside an archive: the archive file and the path
/// inside it ("" for its root). None for ordinary files and folders.
pub fn locate(real: &Path) -> Option<(PathBuf, String)> {
    let mut at = real;
    let mut rest = Vec::new();
    loop {
        match fs::symlink_metadata(at) {
            Ok(meta) => {
                let name = at.file_name()?.to_string_lossy();
                if !meta.is_file() || format(&name).is_none() {
                    return None;
                }
                rest.reverse();
                return Some((at.to_path_buf(), rest.join("/")));
            }
            Err(_) => {
                rest.push(at.file_name()?.to_string_lossy().into_owned());
                at = at.parent()?;
            }
        }
    }
}

fn tool(program: &str) -> Command {
    let mut c = Command::new(program);
    // p7zip reads UTF-8 names right only in a UTF-8 locale
    c.env("LC_ALL", "en_US.utf8").env("LANG", "en_US.utf8").env("PATH", "/usr/bin:/bin:/usr/local/bin");
    c.stdin(Stdio::null());
    c
}

/// Everything in the archive, from a cache kept per user while the archive
/// is unchanged (a big .tar.gz takes a while to read through).
pub fn members(archive: &Path) -> Result<Vec<Member>, ApiError> {
    let meta = fs::metadata(archive)?;
    let key = format!("{}|{}|{}|{}", archive.display(), meta.len(), meta.mtime(), meta.mtime_nsec());
    let cache = cache_dir().map(|d| d.join(format!("{:016x}.json", xxhash_rust::xxh3::xxh3_64(key.as_bytes()))));
    if let Some(list) = cache.as_ref().and_then(|c| fs::read(c).ok()).and_then(|b| serde_json::from_slice(&b).ok()) {
        return Ok(list);
    }
    let name = archive.file_name().unwrap_or_default().to_string_lossy();
    let fmt = format(&name).ok_or_else(|| ApiError::bad_request(t!("non è un archivio", "not an archive")))?;
    let list = read_members(archive, fmt)?;
    if let Some(c) = cache {
        prune(c.parent().unwrap());
        let tmp = c.with_extension("tmp");
        if serde_json::to_vec(&list).ok().and_then(|b| fs::write(&tmp, b).ok()).is_some() {
            let _ = fs::rename(&tmp, &c);
        }
    }
    Ok(list)
}

fn cache_dir() -> Option<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    // SAFETY: getuid cannot fail
    let dir = std::env::temp_dir().join(format!("synofile-{}", unsafe { libc::getuid() }));
    let _ = fs::DirBuilder::new().mode(0o700).create(&dir);
    let meta = fs::symlink_metadata(&dir).ok()?;
    // only a private folder of ours: never follow somebody else's
    (meta.is_dir() && meta.uid() == unsafe { libc::getuid() } && meta.permissions().mode() & 0o077 == 0).then_some(dir)
}

/// Listings unused for a day go.
fn prune(dir: &Path) {
    let Ok(items) = fs::read_dir(dir) else { return };
    let now = std::time::SystemTime::now();
    for item in items.flatten() {
        let old = item.metadata().ok().and_then(|m| m.accessed().ok()).and_then(|t| now.duration_since(t).ok()).is_some_and(|d| d.as_secs() > 86_400);
        if old {
            let _ = fs::remove_file(item.path());
        }
    }
}

fn read_members(archive: &Path, fmt: Format) -> Result<Vec<Member>, ApiError> {
    let mut cmd = match fmt {
        Format::SevenZip => {
            let mut c = tool("7z");
            c.args(["l", "-slt", "-ba", "-p", "-sccUTF-8", "--"]).arg(archive);
            c
        }
        Format::Rar => {
            let mut c = tool("unrar");
            c.args(["lt", "-p-", "--"]).arg(archive);
            c
        }
        Format::Tar(flag) => {
            let mut c = tool("tar");
            c.args(["-t", "-v", "--full-time", "--numeric-owner", "--quoting-style=literal"]);
            if let Some(f) = flag {
                c.arg(f);
            }
            c.arg("-f").arg(archive);
            c
        }
    };
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| ApiError::new(500, t!("strumento non disponibile: {}", "tool not available: {}", e)))?;
    let stdout = BufReader::new(child.stdout.take().unwrap());
    let stderr = child.stderr.take().unwrap();
    let errors = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut std::io::Read::take(stderr, 64 * 1024), &mut s);
        s
    });
    let lines = stdout.lines().map_while(Result::ok);
    let list = match fmt {
        Format::SevenZip => parse_7z(lines),
        Format::Rar => parse_rar(lines),
        Format::Tar(_) => lines.filter_map(|l| parse_tar_line(&l)).collect(),
    };
    let status = child.wait()?;
    let err = errors.join().unwrap_or_default();
    // 7z returns 2 for an unsupported or damaged file; tar 2 for errors
    if !status.success() && list.is_empty() {
        let low = err.to_ascii_lowercase();
        if low.contains("password") || low.contains("encrypted") {
            return Err(ApiError::new(403, t!("archivio protetto da password: usa «Estrai»", "password-protected archive: use Extract")));
        }
        let why = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
        return Err(ApiError::bad_request(t!("impossibile leggere l'archivio: {}", "cannot read the archive: {}", why)));
    }
    Ok(list)
}

fn normalise(raw: &str) -> String {
    let mut p = raw.replace('\\', "/");
    while let Some(r) = p.strip_prefix("./") {
        p = r.to_string();
    }
    p.trim_matches('/').to_string()
}

/// "2026-10-30 00:13:56[,fraction]" in the NAS's local time.
fn local_time(date: &str, time: &str) -> i64 {
    let d: Vec<i32> = date.split('-').filter_map(|x| x.parse().ok()).collect();
    let t: Vec<i32> = time.split([':', ',', '.']).take(3).filter_map(|x| x.parse().ok()).collect();
    if d.len() != 3 || t.len() != 3 {
        return 0;
    }
    // SAFETY: a zeroed tm is valid; mktime only reads and normalises it
    unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        tm.tm_year = d[0] - 1900;
        tm.tm_mon = d[1] - 1;
        tm.tm_mday = d[2];
        tm.tm_hour = t[0];
        tm.tm_min = t[1];
        tm.tm_sec = t[2];
        tm.tm_isdst = -1;
        libc::mktime(&mut tm) as i64
    }
}

/// "drwxr-xr-x" → 0o755 (and the type letter).
fn mode_bits(s: &str) -> (char, u32) {
    let b = s.as_bytes();
    if b.len() < 10 {
        return ('-', 0);
    }
    let mut m = 0;
    for (i, c) in b[1..10].iter().enumerate() {
        if *c != b'-' {
            m |= 1 << (8 - i);
        }
    }
    (b[0] as char, m)
}

fn parse_7z(lines: impl Iterator<Item = String>) -> Vec<Member> {
    let mut out = Vec::new();
    let mut cur: BTreeMap<String, String> = BTreeMap::new();
    let mut flush = |cur: &mut BTreeMap<String, String>| {
        if let Some(raw) = cur.get("Path").cloned() {
            let attrs = cur.get("Attributes").cloned().unwrap_or_default();
            let unix = attrs.split_whitespace().find(|w| w.len() == 10);
            let (kind, mut mode) = unix.map(mode_bits).unwrap_or(('-', 0));
            let dir = cur.get("Folder").is_some_and(|f| f == "+") || attrs.starts_with('D') || kind == 'd';
            if mode == 0 {
                mode = if dir { 0o755 } else { 0o644 };
            }
            let (date, time) = cur.get("Modified").and_then(|m| m.split_once(' ')).unwrap_or(("", ""));
            out.push(Member {
                path: normalise(&raw),
                raw,
                dir,
                link: kind == 'l',
                size: cur.get("Size").and_then(|s| s.parse().ok()).unwrap_or(0),
                mtime: local_time(date, time),
                mode,
            });
        }
        cur.clear();
    };
    for line in lines {
        if line.trim().is_empty() {
            flush(&mut cur);
        } else if let Some((k, v)) = line.split_once(" = ") {
            cur.insert(k.trim().to_string(), v.to_string());
        } else if let Some(k) = line.strip_suffix(" =") {
            cur.insert(k.trim().to_string(), String::new());
        }
    }
    flush(&mut cur);
    out
}

fn parse_rar(lines: impl Iterator<Item = String>) -> Vec<Member> {
    let mut out = Vec::new();
    let mut cur: BTreeMap<String, String> = BTreeMap::new();
    let mut flush = |cur: &mut BTreeMap<String, String>| {
        if let Some(raw) = cur.get("Name").cloned() {
            let kind = cur.get("Type").cloned().unwrap_or_default();
            let (letter, mut mode) = cur.get("Attributes").map(|a| mode_bits(a)).unwrap_or(('-', 0));
            let dir = kind == "Directory" || letter == 'd';
            if mode == 0 {
                mode = if dir { 0o755 } else { 0o644 };
            }
            let (date, time) = cur.get("mtime").and_then(|m| m.split_once(' ')).unwrap_or(("", ""));
            out.push(Member {
                path: normalise(&raw),
                raw,
                dir,
                link: kind.contains("link") || letter == 'l',
                size: cur.get("Size").and_then(|s| s.parse().ok()).unwrap_or(0),
                mtime: local_time(date, time),
                mode,
            });
        }
        cur.clear();
    };
    for line in lines {
        let Some((k, v)) = line.split_once(": ") else { continue };
        let k = k.trim();
        if k == "Name" {
            flush(&mut cur);
        }
        cur.insert(k.to_string(), v.trim_end().to_string());
    }
    flush(&mut cur);
    out
}

/// "-rw-r--r-- 0/0   2 2026-10-30 00:13:56 d/a b.txt"; links end in
/// " -> target" or " link to target".
fn parse_tar_line(line: &str) -> Option<Member> {
    let mut rest = line;
    let mut fields = Vec::new();
    for _ in 0..5 {
        rest = rest.trim_start();
        let end = rest.find(' ')?;
        fields.push(&rest[..end]);
        rest = &rest[end..];
    }
    let mut name = rest.strip_prefix(' ')?.to_string();
    let (kind, mode) = mode_bits(fields[0]);
    if kind == 'l' {
        if let Some(i) = name.find(" -> ") {
            name.truncate(i);
        }
    } else if kind == 'h' {
        if let Some(i) = name.find(" link to ") {
            name.truncate(i);
        }
    }
    Some(Member {
        path: normalise(&name),
        raw: name,
        dir: kind == 'd',
        link: kind == 'l',
        size: if kind == 'd' { 0 } else { fields[2].parse().unwrap_or(0) },
        mtime: local_time(fields[3], fields[4]),
        mode,
    })
}

/// The items directly inside `dir` ("" for the root), folders made up for
/// the paths that only appear inside others.
pub fn children(members: &[Member], dir: &str) -> Vec<Entry> {
    let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
    let mut seen: BTreeMap<String, Entry> = BTreeMap::new();
    for m in members {
        let Some(rest) = m.path.strip_prefix(&prefix) else { continue };
        if rest.is_empty() {
            continue;
        }
        match rest.split_once('/') {
            Some((name, _)) => {
                seen.entry(name.to_string()).or_insert_with(|| folder(name, m.mtime));
            }
            None => {
                let e = Entry {
                    name: rest.to_string(),
                    kind: if m.dir { 'd' } else if m.link { 'l' } else { 'f' },
                    size: if m.dir { 0 } else { m.size },
                    mtime: m.mtime,
                    mode: m.mode,
                    link_dir: false,
                    thumb: false,
                };
                // a real entry wins over a made-up folder
                seen.insert(rest.to_string(), e);
            }
        }
    }
    seen.into_values().collect()
}

fn folder(name: &str, mtime: i64) -> Entry {
    Entry { name: name.to_string(), kind: 'd', size: 0, mtime, mode: 0o755, link_dir: false, thumb: false }
}

/// Whether `path` is a folder inside the archive ("" is the root).
pub fn is_dir(members: &[Member], path: &str) -> bool {
    path.is_empty() || members.iter().any(|m| m.path == path && m.dir) || members.iter().any(|m| m.path.len() > path.len() && m.path.starts_with(path) && m.path.as_bytes()[path.len()] == b'/')
}

pub fn find<'a>(members: &'a [Member], path: &str) -> Option<&'a Member> {
    members.iter().rev().find(|m| m.path == path && !m.dir)
}

/// Files, folders and bytes under `path` (a folder inside the archive).
pub fn usage(members: &[Member], path: &str) -> (u64, u64, u64) {
    let prefix = if path.is_empty() { String::new() } else { format!("{path}/") };
    let mut dirs = std::collections::BTreeSet::new();
    let (mut files, mut bytes) = (0, 0);
    for m in members.iter().filter(|m| m.path.starts_with(&prefix) && m.path.len() > prefix.len()) {
        let rest = &m.path[prefix.len()..];
        // every folder on the way counts once
        let mut at = 0;
        while let Some(i) = rest[at..].find('/') {
            dirs.insert(&rest[..at + i]);
            at += i + 1;
        }
        if m.dir {
            dirs.insert(rest);
        } else {
            files += 1;
            bytes += m.size;
        }
    }
    (files, dirs.len() as u64, bytes)
}

/// A command that writes one member to its standard output.
pub fn cat(archive: &Path, member: &Member) -> Command {
    let name = archive.file_name().unwrap_or_default().to_string_lossy().into_owned();
    match format(&name) {
        Some(Format::Rar) => {
            let mut c = tool("unrar");
            c.args(["p", "-inul", "-p-", "--"]).arg(archive).arg(&member.raw);
            c
        }
        Some(Format::Tar(flag)) => {
            let mut c = tool("tar");
            c.args(["-x", "-O"]);
            if let Some(f) = flag {
                c.arg(f);
            }
            c.arg("-f").arg(archive).arg("--").arg(&member.raw);
            c
        }
        _ => {
            let mut c = tool("7z");
            c.args(["x", "-so", "-p", "-spd", "-sccUTF-8", "--"]).arg(archive).arg(&member.raw);
            c
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        assert_eq!(format("a.ZIP"), Some(Format::SevenZip));
        assert_eq!(format("a.tar.gz"), Some(Format::Tar(Some("-z"))));
        assert_eq!(format("a.tar"), Some(Format::Tar(None)));
        assert_eq!(format("a.rar"), Some(Format::Rar));
        assert_eq!(format("a.gz"), None);
        assert_eq!(format("a.txt"), None);
    }

    #[test]
    fn tar_lines() {
        let m = parse_tar_line("-rw-r--r-- 0/0               2 2026-10-30 00:13:56 ./d/a b.txt").unwrap();
        assert_eq!((m.path.as_str(), m.size, m.mode, m.dir), ("d/a b.txt", 2, 0o644, false));
        let d = parse_tar_line("drwxr-xr-x 1000/100         0 2026-10-30 00:13:56 d/").unwrap();
        assert_eq!((d.path.as_str(), d.dir, d.raw.as_str()), ("d", true, "d/"));
        let l = parse_tar_line("lrwxrwxrwx 0/0               0 2026-10-30 00:13:56 d/link -> a b.txt").unwrap();
        assert_eq!((l.path.as_str(), l.link), ("d/link", true));
    }

    #[test]
    fn sevenzip_blocks() {
        let text = "Path = d\nFolder = +\nSize = 0\nModified = 2026-10-30 00:13:56\nAttributes = D_ drwxr-xr-x\n\nPath = d/sub/è.txt\nFolder = -\nSize = 5\nModified = 2026-10-30 00:13:56\nAttributes = _ -rw-r--r--\nComment = \n";
        let list = parse_7z(text.lines().map(String::from));
        assert_eq!(list.len(), 2);
        assert!(list[0].dir);
        assert_eq!((list[1].path.as_str(), list[1].size, list[1].mode), ("d/sub/è.txt", 5, 0o644));
        let root = children(&list, "");
        assert_eq!(root.len(), 1);
        let d = children(&list, "d");
        assert_eq!((d[0].name.as_str(), d[0].kind), ("sub", 'd'));
        assert!(is_dir(&list, "d/sub"));
        assert!(!is_dir(&list, "d/sub/è.txt"));
        assert_eq!(usage(&list, "d"), (1, 1, 5));
    }

    #[test]
    fn rar_blocks() {
        let text = "Archive: x.rar\nDetails: RAR 5\n\n        Name: d/a.txt\n        Type: File\n        Size: 2\n       mtime: 2026-10-30 00:13:56,000000000\n  Attributes: -rw-r--r--\n\n        Name: d\n        Type: Directory\n  Attributes: drwxr-xr-x\n";
        let list = parse_rar(text.lines().map(String::from));
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].path.as_str(), list[0].size), ("d/a.txt", 2));
        assert!(list[1].dir);
    }

    #[test]
    fn locate_inside() {
        let dir = std::env::temp_dir().join(format!("synofile-arch-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("x.zip"), b"PK").unwrap();
        assert_eq!(locate(&dir.join("x.zip/a/b")), Some((dir.join("x.zip"), "a/b".to_string())));
        assert_eq!(locate(&dir.join("x.zip")), Some((dir.join("x.zip"), String::new())));
        assert_eq!(locate(&dir.join("nothing/a")), None);
        fs::remove_dir_all(&dir).unwrap();
    }
}
