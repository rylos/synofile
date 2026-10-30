//! Space analysis: what takes up the room below a folder, as a tree the
//! interface draws in rings.
//!
//! Folders are read by a pool of threads sharing one queue, so a disk with
//! many folders has several reads in flight. Synology's own folders (`@…`
//! and `#…` at the top of a shared folder, `@eaDir`, snapshots and the
//! recycle bin anywhere) are left out, and a file with several hard links
//! counts once. Nothing mounted below the folder is entered, as `du -x`:
//! Active Backup's ActiveBackupData is a FUSE view showing every version as
//! a whole disk image (its deduplicated data is `@ActiveBackup`), snapshots
//! are mounted on `#snapshot`. Read-only btrfs subvolumes are snapshots
//! too (btrbk's, received ones) and are left out. The tree sent back is
//! pruned: items smaller than a fraction
//! of the whole are summed into one "other" piece per folder.

use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::fsops::is_system_name;

/// The largest files kept by name in each folder; the rest are summed.
const KEEP_FILES: usize = 24;
/// Pieces below this fraction of the whole are summed into "other".
const SHARE: u64 = 1500;
const DEPTH: usize = 12;

/// Left out of the analysis: thumbnails and indexes (`@eaDir`…),
/// snapshots, the recycle bin and, at the top of a shared folder, DSM's own
/// (`@tmp`, `@sharebin`…). Deeper down a `@` name is the user's (npm's
/// `@scope` folders).
pub fn skipped(name: &str, top: bool) -> bool {
    is_system_name(name)
        || matches!(name, "#snapshot" | "@SynoResource" | "@SynoEAStream" | "@__thumb")
        || name == crate::shares::RECYCLE
        || (top && (name.starts_with('@') || name.starts_with('#')))
}

#[derive(Default)]
struct Dir {
    parent: u32,
    name: String,
    /// with everything below, once summed
    /// files of this folder alone: the largest by name, the others summed
    big: Vec<(String, u64)>,
    rest: u64,
    rest_files: u64,
    children: Vec<u32>,
    bytes: u64,
    files: u64,
}

#[derive(Serialize)]
pub struct Node {
    /// name; empty for the "other" piece
    pub n: String,
    pub s: u64,
    /// d folder, f file, o smaller items summed
    pub k: char,
    /// files inside (folders and "other")
    #[serde(skip_serializing_if = "is_zero")]
    pub f: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub c: Vec<Node>,
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}

#[derive(Serialize)]
pub struct Analysis {
    pub root: Node,
    pub dirs: u64,
    pub unreadable: u64,
    pub ms: u64,
    /// stopped at the deadline: what is there is a lower bound
    pub partial: bool,
}

struct Queue {
    todo: Vec<(PathBuf, u32)>,
    busy: usize,
}

/// `share` is the top of the shared folder `root` is in.
pub fn analyse(root: &Path, share: &Path, budget: Duration) -> Analysis {
    let start = Instant::now();
    let deadline = start + budget;
    let dirs = Mutex::new(vec![Dir { parent: u32::MAX, ..Default::default() }]);
    let queue = Mutex::new(Queue { todo: vec![(root.to_path_buf(), 0)], busy: 0 });
    let wake = Condvar::new();
    let seen = Mutex::new(HashSet::<(u64, u64)>::new());
    let unreadable = AtomicU64::new(0);
    let partial = AtomicBool::new(false);
    let mounts = mounts_below(root);
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get() * 2).clamp(4, 16);

    let work = || loop {
        let (path, id) = {
            let mut q = queue.lock().unwrap();
            loop {
                if let Some(next) = q.todo.pop() {
                    q.busy += 1;
                    break next;
                }
                if q.busy == 0 {
                    wake.notify_all();
                    return;
                }
                q = wake.wait(q).unwrap();
            }
        };
        let mut subdirs = Vec::new();
        let mut files: Vec<(String, u64)> = Vec::new();
        if Instant::now() > deadline {
            partial.store(true, Ordering::Relaxed);
        } else if let Ok(rd) = fs::read_dir(&path) {
            let top = path == share;
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if skipped(&name, top) {
                    continue;
                }
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_dir() {
                    let full = path.join(&name);
                    if (mounts.is_empty() || !mounts.contains(&full)) && !snapshot(&e, &full) {
                        subdirs.push(name);
                    }
                    continue;
                }
                let Ok(meta) = e.metadata() else {
                    unreadable.fetch_add(1, Ordering::Relaxed);
                    continue;
                };
                if meta.nlink() > 1 && ft.is_file() && !seen.lock().unwrap().insert((meta.dev(), meta.ino())) {
                    continue;
                }
                files.push((name, meta.len()));
            }
        } else {
            unreadable.fetch_add(1, Ordering::Relaxed);
        }
        files.sort_unstable_by(|a, b| b.1.cmp(&a.1));
        let rest: Vec<_> = files.split_off(files.len().min(KEEP_FILES));
        let mut more = Vec::with_capacity(subdirs.len());
        {
            let mut d = dirs.lock().unwrap();
            let first = d.len() as u32;
            for (i, name) in subdirs.into_iter().enumerate() {
                more.push((path.join(&name), first + i as u32));
                d.push(Dir { parent: id, name, ..Default::default() });
            }
            let me = &mut d[id as usize];
            me.children = (first..first + more.len() as u32).collect();
            me.rest = rest.iter().map(|f| f.1).sum();
            me.rest_files = rest.len() as u64;
            me.big = files;
        }
        let mut q = queue.lock().unwrap();
        q.todo.extend(more);
        q.busy -= 1;
        wake.notify_all();
    };
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(work);
        }
    });

    let mut dirs = dirs.into_inner().unwrap();
    // children always come after their parent: sum from the end
    let own: Vec<(u64, u64)> = dirs.iter().map(|d| (d.rest + d.big.iter().map(|f| f.1).sum::<u64>(), d.rest_files + d.big.len() as u64)).collect();
    for i in (0..dirs.len()).rev() {
        dirs[i].bytes += own[i].0;
        dirs[i].files += own[i].1;
        let (b, f, p) = (dirs[i].bytes, dirs[i].files, dirs[i].parent);
        if p != u32::MAX {
            dirs[p as usize].bytes += b;
            dirs[p as usize].files += f;
        }
    }

    let floor = (dirs[0].bytes / SHARE).max(1);
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut tree = prune(&dirs, 0, floor, 0);
    tree.n = name;
    Analysis {
        root: tree,
        dirs: dirs.len() as u64,
        unreadable: unreadable.load(Ordering::Relaxed),
        ms: start.elapsed().as_millis() as u64,
        partial: partial.load(Ordering::Relaxed),
    }
}

/// A read-only btrfs subvolume: the root of a subvolume has inode 256.
fn snapshot(e: &fs::DirEntry, path: &Path) -> bool {
    const FIRST_FREE_OBJECTID: u64 = 256;
    const SUBVOL_GETFLAGS: libc::c_ulong = 0x8008_9419; // _IOR(0x94, 25, u64)
    const SUBVOL_RDONLY: u64 = 2;
    if !e.metadata().is_ok_and(|m| m.ino() == FIRST_FREE_OBJECTID) {
        return false;
    }
    let Ok(dir) = fs::File::open(path) else { return false };
    let mut flags: u64 = 0;
    // SAFETY: an open directory and a u64 for the ioctl to fill
    let rc = unsafe { libc::ioctl(std::os::fd::AsRawFd::as_raw_fd(&dir), SUBVOL_GETFLAGS as _, &mut flags) };
    rc == 0 && flags & SUBVOL_RDONLY != 0
}

/// The mount points strictly below `root`, from /proc/self/mountinfo.
fn mounts_below(root: &Path) -> HashSet<PathBuf> {
    let Ok(info) = fs::read_to_string("/proc/self/mountinfo") else { return HashSet::new() };
    info.lines()
        .filter_map(|l| l.split(' ').nth(4))
        .map(|m| PathBuf::from(unescape(m)))
        .filter(|m| m != root && m.starts_with(root))
        .collect()
}

/// mountinfo writes space, tab, newline and backslash as \040 and the like.
fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 3 < b.len() && b[i + 1..i + 4].iter().all(|c| (b'0'..=b'7').contains(c)) {
            out.push((b[i + 1] - b'0') * 64 + (b[i + 2] - b'0') * 8 + (b[i + 3] - b'0'));
            i += 4;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn prune(dirs: &[Dir], id: usize, floor: u64, depth: usize) -> Node {
    let d = &dirs[id];
    let mut c = Vec::new();
    let (mut other, mut other_files) = (d.rest, d.rest_files);
    for &child in &d.children {
        let x = &dirs[child as usize];
        if x.bytes >= floor && depth < DEPTH {
            c.push(prune(dirs, child as usize, floor, depth + 1));
        } else {
            other += x.bytes;
            other_files += x.files;
        }
    }
    for (name, size) in &d.big {
        if *size >= floor {
            c.push(Node { n: name.clone(), s: *size, k: 'f', f: 0, c: Vec::new() });
        } else {
            other += size;
            other_files += 1;
        }
    }
    c.sort_unstable_by(|a, b| b.s.cmp(&a.s));
    if other > 0 {
        c.push(Node { n: String::new(), s: other, k: 'o', f: other_files, c: Vec::new() });
    }
    Node { n: d.name.clone(), s: d.bytes, k: 'd', f: d.files, c }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unescapes_mountinfo() {
        assert_eq!(unescape("/volume1/a\\040b"), "/volume1/a b");
        assert_eq!(unescape("/x\\"), "/x\\");
    }

    #[test]
    fn sums_and_skips() {
        let root = std::env::temp_dir().join(format!("synofile-space-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::create_dir_all(root.join("#snapshot/x")).unwrap();
        fs::create_dir_all(root.join("@eaDir")).unwrap();
        fs::write(root.join("a/b/big"), vec![0u8; 10_000]).unwrap();
        fs::write(root.join("a/small"), vec![0u8; 3]).unwrap();
        fs::write(root.join("top"), vec![0u8; 500]).unwrap();
        fs::hard_link(root.join("top"), root.join("top2")).unwrap();
        fs::write(root.join("#snapshot/x/huge"), vec![0u8; 50_000]).unwrap();
        fs::write(root.join("@eaDir/thumb"), vec![0u8; 50_000]).unwrap();
        fs::create_dir_all(root.join("a/@scope")).unwrap();
        fs::write(root.join("a/@scope/pkg"), vec![0u8; 7]).unwrap();
        let a = analyse(&root, &root, Duration::from_secs(10));
        assert_eq!(a.root.s, 10_510);
        assert_eq!(a.root.f, 4);
        assert_eq!(a.root.c[0].n, "a");
        assert_eq!(a.root.c[0].s, 10_010);
        assert_eq!(a.root.c[0].c[0].c[0].n, "big");
        assert!(!a.partial);
        fs::remove_dir_all(&root).unwrap();
    }
}
