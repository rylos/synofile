//! Two folder trees side by side, for synchronizing them: what is only on
//! one side (a folder there is reported whole, not walked), and the files
//! on both sides that differ, by size or by date (two seconds of slack, as
//! FAT and SMB keep). The answer streams JSON lines like the checksum's.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;

use crate::cgi::{self, ApiError};

const MAX: usize = 20000;

#[derive(Serialize, Debug, PartialEq)]
pub struct Diff {
    /// relative to both roots
    pub path: String,
    /// a: only on the left, b: only on the right, newer_a / newer_b: on both,
    /// one newer; size: on both, same date, another size; kind: a file on
    /// one side, a folder on the other; unreadable: a side could not be read
    /// there, so nothing about it can be decided (never a deletion)
    pub what: &'static str,
    pub dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub a: Option<Side>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub b: Option<Side>,
}

#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
pub struct Side {
    pub size: u64,
    pub mtime: i64,
}

struct Node {
    dir: bool,
    side: Side,
    /// its details could not be read
    unreadable: bool,
}

/// The items of a folder; None when the folder cannot be read. Names that
/// are not UTF-8 are left out (counted in `skipped`): a path rebuilt from
/// a lossy name would point at nothing, or at something else.
fn children(dir: &Path, skipped: &mut u64) -> Option<BTreeMap<String, Node>> {
    let mut out = BTreeMap::new();
    let rd = fs::read_dir(dir).ok()?;
    for item in rd {
        let Ok(item) = item else { return None };
        let Ok(name) = item.file_name().into_string() else {
            *skipped += 1;
            continue;
        };
        if crate::fsops::is_system_name(&name) || name == crate::shares::RECYCLE || name == "#snapshot" {
            continue;
        }
        // a symbolic link is compared as itself, never followed
        let node = match fs::symlink_metadata(item.path()) {
            Ok(meta) => Node { dir: meta.is_dir(), side: Side { size: if meta.is_dir() { 0 } else { meta.len() }, mtime: meta.mtime() }, unreadable: false },
            Err(_) => Node { dir: false, side: Side { size: 0, mtime: 0 }, unreadable: true },
        };
        out.insert(name, node);
    }
    Some(out)
}

/// The same date, give or take: two seconds (FAT, SMB), or one hour and two
/// seconds (FAT and exFAT keep local time, and summer time moves it).
fn same_time(a: i64, b: i64) -> bool {
    let d = (a - b).abs();
    d <= 2 || (3598..=3602).contains(&d)
}

pub fn send(out: &mut impl Write, a: &Path, b: &Path) -> Result<(), ApiError> {
    if !fs::metadata(a)?.is_dir() || !fs::metadata(b)?.is_dir() {
        return Err(ApiError::bad_request(t!("si confrontano due cartelle", "two folders are compared")));
    }
    cgi::head(out, 200, &[("Content-Type", "application/x-ndjson"), ("X-Accel-Buffering", "no")])?;
    out.flush()?;
    let mut at = Instant::now();
    let mut tick = |n: u64| -> io::Result<()> {
        if at.elapsed() < Duration::from_millis(500) {
            return Ok(());
        }
        at = Instant::now();
        writeln!(out, "{}", json!({ "folders": n }))?;
        out.flush()
    };
    let result = compare(a, b, &mut tick);
    let line = match result {
        Ok((diffs, folders, more, skipped)) => json!({ "diffs": diffs, "folders": folders, "more": more, "skipped": skipped }),
        Err(e) if e.kind() == io::ErrorKind::BrokenPipe => return Ok(()),
        Err(e) => json!({ "error": crate::fsops::describe(&e) }),
    };
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
    Ok(())
}

pub fn compare(a: &Path, b: &Path, tick: &mut impl FnMut(u64) -> io::Result<()>) -> io::Result<(Vec<Diff>, u64, bool, u64)> {
    let mut diffs = Vec::new();
    let mut folders = 0u64;
    let mut skipped = 0u64;
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        folders += 1;
        tick(folders)?;
        let (Some(left), Some(right)) = (children(&a.join(&rel), &mut skipped), children(&b.join(&rel), &mut skipped)) else {
            // one side cannot be read here: what it lacks is unknown, not missing
            if diffs.len() >= MAX {
                return Ok((diffs, folders, true, skipped));
            }
            diffs.push(Diff { path: rel.to_string_lossy().into_owned(), what: "unreadable", dir: true, a: None, b: None });
            continue;
        };
        let names: std::collections::BTreeSet<&String> = left.keys().chain(right.keys()).collect();
        for name in names {
            let path = rel.join(name).to_string_lossy().into_owned();
            let (l, r) = (left.get(name), right.get(name));
            let diff = match (l, r) {
                (Some(l), r) if l.unreadable || r.is_some_and(|r| r.unreadable) => Some(Diff { path, what: "unreadable", dir: false, a: None, b: None }),
                (None, Some(r)) if r.unreadable => Some(Diff { path, what: "unreadable", dir: false, a: None, b: None }),
                (Some(l), None) => Some(Diff { path, what: "a", dir: l.dir, a: Some(l.side), b: None }),
                (None, Some(r)) => Some(Diff { path, what: "b", dir: r.dir, a: None, b: Some(r.side) }),
                (Some(l), Some(r)) if l.dir != r.dir => Some(Diff { path, what: "kind", dir: l.dir, a: Some(l.side), b: Some(r.side) }),
                (Some(l), Some(_)) if l.dir => {
                    stack.push(rel.join(name));
                    None
                }
                (Some(l), Some(r)) => {
                    let what = if same_time(l.side.mtime, r.side.mtime) {
                        (l.side.size != r.side.size).then_some("size")
                    } else if l.side.mtime > r.side.mtime {
                        Some("newer_a")
                    } else {
                        Some("newer_b")
                    };
                    what.map(|what| Diff { path, what, dir: false, a: Some(l.side), b: Some(r.side) })
                }
                (None, None) => None,
            };
            if let Some(d) = diff {
                if diffs.len() >= MAX {
                    return Ok((diffs, folders, true, skipped));
                }
                diffs.push(d);
            }
        }
    }
    diffs.sort_by(|x, y| x.path.cmp(&y.path));
    Ok((diffs, folders, false, skipped))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_two_trees() {
        let base = std::env::temp_dir().join(format!("synofile-cmp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let (a, b) = (base.join("a"), base.join("b"));
        for d in [&a, &b] {
            fs::create_dir_all(d.join("both")).unwrap();
            fs::write(d.join("same.txt"), "x").unwrap();
        }
        fs::create_dir_all(a.join("onlya/deep")).unwrap();
        fs::write(a.join("both/new.txt"), "new").unwrap();
        fs::write(b.join("both/new.txt"), "old").unwrap();
        fs::write(b.join("onlyb.txt"), "b").unwrap();
        fs::write(a.join("kind"), "f").unwrap();
        fs::create_dir_all(b.join("kind")).unwrap();
        // the same date on both sides of same.txt; new.txt newer on the left
        let set = |p: &Path, t: i64| {
            let f = fs::File::options().write(true).open(p).unwrap();
            f.set_modified(std::time::UNIX_EPOCH + Duration::from_secs(t as u64)).unwrap();
        };
        set(&a.join("same.txt"), 1_000_000);
        set(&b.join("same.txt"), 1_000_001);
        set(&a.join("both/new.txt"), 2_000_000);
        set(&b.join("both/new.txt"), 1_000_000);
        let (diffs, _, more, _) = compare(&a, &b, &mut |_| Ok(())).unwrap();
        assert!(!more);
        let got: Vec<(&str, &str)> = diffs.iter().map(|d| (d.path.as_str(), d.what)).collect();
        assert_eq!(got, vec![("both/new.txt", "newer_a"), ("kind", "kind"), ("onlya", "a"), ("onlyb.txt", "b")]);
        // a folder of the right that cannot be read: unknown, never "only on the left"
        use std::os::unix::fs::PermissionsExt;
        fs::write(a.join("both/x.txt"), "x").unwrap();
        fs::set_permissions(b.join("both"), fs::Permissions::from_mode(0o000)).unwrap();
        let readable = fs::read_dir(b.join("both")).is_ok(); // root reads anyway
        let (diffs, _, _, _) = compare(&a, &b, &mut |_| Ok(())).unwrap();
        fs::set_permissions(b.join("both"), fs::Permissions::from_mode(0o755)).unwrap();
        if !readable {
            assert!(diffs.iter().any(|d| d.path == "both" && d.what == "unreadable"));
            assert!(!diffs.iter().any(|d| d.path.starts_with("both/")));
        }
        let _ = fs::remove_dir_all(&base);
    }
}
