//! Duplicate files under a folder. Files
//! of the same size are candidates; by content, their first and last 64 KiB
//! are hashed first, and only those still alike are read whole (xxh3-128).
//! Hard links to one file are one file, not duplicates. The answer streams
//! JSON lines like the checksum's: progress, then the groups.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;

use crate::cgi::{self, ApiError};

const EDGE: u64 = 64 * 1024;
const MAX_GROUPS: usize = 5000;

#[derive(Clone)]
struct Found {
    rel: String,
    size: u64,
    mtime: i64,
    path: PathBuf,
}

#[derive(Serialize)]
struct Item {
    path: String,
    mtime: i64,
}

#[derive(Serialize)]
struct Group {
    size: u64,
    items: Vec<Item>,
}

/// Throttled progress lines; an error writing them means the browser went away.
struct Report<'a, W: Write> {
    out: &'a mut W,
    at: Instant,
}

impl<W: Write> Report<'_, W> {
    fn tick(&mut self, line: impl FnOnce() -> serde_json::Value) -> io::Result<()> {
        if self.at.elapsed() < Duration::from_millis(500) {
            return Ok(());
        }
        self.at = Instant::now();
        writeln!(self.out, "{}", line())?;
        self.out.flush()
    }
}

/// `by`: "content" or "name" (same name and size, nothing read). `min`: smallest size looked at.
pub fn send(out: &mut impl Write, root: &Path, by: &str, min: u64) -> Result<(), ApiError> {
    if !fs::metadata(root)?.is_dir() {
        return Err(ApiError::bad_request(t!("i duplicati si cercano in una cartella", "duplicates are looked for in a folder")));
    }
    let by_name = match by {
        "content" => false,
        "name" => true,
        _ => return Err(ApiError::bad_request("by")),
    };
    cgi::head(out, 200, &[("Content-Type", "application/x-ndjson"), ("X-Accel-Buffering", "no")])?;
    out.flush()?;
    let mut report = Report { out, at: Instant::now() - Duration::from_secs(1) };
    let result = find(root, by_name, min.max(1), &mut report);
    let out = report.out;
    let line = match result {
        Ok((groups, scanned, more)) => json!({ "groups": groups, "scanned": scanned, "more": more }),
        Err(e) if e.kind() == io::ErrorKind::BrokenPipe => return Ok(()),
        Err(e) => json!({ "error": crate::fsops::describe(&e) }),
    };
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
    Ok(())
}

fn find<W: Write>(root: &Path, by_name: bool, min: u64, report: &mut Report<W>) -> io::Result<(Vec<Group>, u64, bool)> {
    // 1. every file, once per inode
    let mut by_size: HashMap<(u64, String), Vec<Found>> = HashMap::new();
    let mut inodes = std::collections::HashSet::new();
    let mut scanned = 0u64;
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        let Ok(rd) = fs::read_dir(root.join(&rel)) else { continue };
        for item in rd.flatten() {
            // a name that is not UTF-8 would come back as a path to nothing, or to something else
            let Ok(name) = item.file_name().into_string() else { continue };
            if crate::fsops::is_system_name(&name) || name == crate::shares::RECYCLE || name == "#snapshot" {
                continue;
            }
            let Ok(kind) = item.file_type() else { continue };
            if kind.is_dir() {
                stack.push(rel.join(&name));
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let Ok(meta) = item.metadata() else { continue };
            scanned += 1;
            report.tick(|| json!({ "phase": "scan", "files": scanned }))?;
            if meta.len() < min || !inodes.insert((meta.dev(), meta.ino())) {
                continue;
            }
            let key = (meta.len(), if by_name { name.to_lowercase() } else { String::new() });
            by_size.entry(key).or_default().push(Found {
                rel: rel.join(&name).to_str().unwrap_or_default().to_owned(),
                size: meta.len(),
                mtime: meta.mtime(),
                path: item.path(),
            });
        }
    }
    let mut candidates: Vec<Vec<Found>> = by_size.into_values().filter(|v| v.len() > 1).collect();
    if !by_name {
        // 2. the edges, then 3. the whole of what is still alike
        let total: u64 = candidates.iter().flatten().map(|f| f.size).sum();
        let mut done = 0u64;
        let mut next = Vec::new();
        for group in candidates {
            for g in split(group, |f| edges(&f.path, f.size))? {
                if g.len() < 2 {
                    done += g.iter().map(|f| f.size).sum::<u64>();
                    continue;
                }
                if g[0].size <= 2 * EDGE {
                    // the edges were the whole file
                    done += g.iter().map(|f| f.size).sum::<u64>();
                    next.push(g);
                    continue;
                }
                let mut whole = |f: &Found| -> io::Result<Option<u128>> {
                    let h = full(&f.path, &mut |n| {
                        done += n;
                        report.tick(|| json!({ "phase": "hash", "done": done, "total": total }))
                    })?;
                    Ok(h)
                };
                next.extend(split(g, &mut whole)?.into_iter().filter(|g| g.len() > 1));
            }
            report.tick(|| json!({ "phase": "hash", "done": done, "total": total }))?;
        }
        candidates = next;
    }
    // the most room wasted first
    candidates.sort_by_key(|g| std::cmp::Reverse(g[0].size * (g.len() as u64 - 1)));
    let more = candidates.len() > MAX_GROUPS;
    let groups = candidates
        .into_iter()
        .take(MAX_GROUPS)
        .map(|mut g| {
            g.sort_by(|a, b| a.rel.cmp(&b.rel));
            Group { size: g[0].size, items: g.into_iter().map(|f| Item { path: f.rel, mtime: f.mtime }).collect() }
        })
        .collect();
    Ok((groups, scanned, more))
}

/// Splits a group by a key; a file that cannot be read drops out.
fn split<K: std::hash::Hash + Eq>(group: Vec<Found>, mut key: impl FnMut(&Found) -> io::Result<Option<K>>) -> io::Result<Vec<Vec<Found>>> {
    let mut parts: HashMap<K, Vec<Found>> = HashMap::new();
    for f in group {
        match key(&f) {
            Ok(Some(k)) => parts.entry(k).or_default().push(f),
            Ok(None) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(parts.into_values().collect())
}

/// The first and last 64 KiB; None when the file cannot be read.
fn edges(path: &Path, size: u64) -> io::Result<Option<u128>> {
    let Ok(mut f) = File::open(path) else { return Ok(None) };
    let mut h = xxhash_rust::xxh3::Xxh3::new();
    let mut buf = vec![0u8; EDGE.min(size) as usize];
    if f.read_exact(&mut buf).is_err() {
        return Ok(None);
    }
    h.update(&buf);
    if size > EDGE {
        let tail = EDGE.min(size - EDGE);
        let mut buf = vec![0u8; tail as usize];
        if f.seek(SeekFrom::End(-(tail as i64))).is_err() || f.read_exact(&mut buf).is_err() {
            return Ok(None);
        }
        h.update(&buf);
    }
    Ok(Some(h.digest128()))
}

/// The whole file; `tick` hears of every chunk and stops all when the browser is gone.
fn full(path: &Path, tick: &mut impl FnMut(u64) -> io::Result<()>) -> io::Result<Option<u128>> {
    let Ok(mut f) = File::open(path) else { return Ok(None) };
    let mut h = xxhash_rust::xxh3::Xxh3::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => return Ok(None),
        };
        h.update(&buf[..n]);
        tick(n as u64)?;
    }
    Ok(Some(h.digest128()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_duplicates_by_content_not_links() {
        let dir = std::env::temp_dir().join(format!("synofile-dupes-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        let big: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let mut other = big.clone();
        other[150_000] ^= 1; // same size and edges, another middle
        fs::write(dir.join("a.bin"), &big).unwrap();
        fs::write(dir.join("sub/b.bin"), &big).unwrap();
        fs::write(dir.join("c.bin"), &other).unwrap();
        fs::hard_link(dir.join("a.bin"), dir.join("link.bin")).unwrap();
        fs::write(dir.join("x.txt"), "same").unwrap();
        fs::write(dir.join("sub/x.txt"), "same").unwrap();
        let mut sink = Vec::new();
        let mut report = Report { out: &mut sink, at: Instant::now() };
        let (groups, scanned, more) = find(&dir, false, 1, &mut report).unwrap();
        assert_eq!(scanned, 6);
        assert!(!more);
        let paths: Vec<Vec<String>> = groups.iter().map(|g| g.items.iter().map(|i| i.path.clone()).collect()).collect();
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0].len(), 2);
        assert!(paths[0][0].ends_with(".bin") && paths[0].contains(&"sub/b.bin".to_string()));
        assert_eq!(paths[1], vec!["sub/x.txt".to_string(), "x.txt".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }
}
