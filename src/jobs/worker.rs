//! The process that moves the data. The daemon starts one per job, already
//! running as the user who asked, and reads its progress from stdout; the
//! commands (pause, cancel, an answer to a conflict) arrive on stdin.
//!
//! Copies go through a hidden temporary name beside the destination and
//! are renamed into place once complete, so an interrupted copy never
//! leaves a half file under the real name. On btrfs a copy is first tried
//! as a reflink clone, which shares the data and takes no time; moves are
//! renames whenever source and destination are the same subvolume.

use std::ffi::{CString, OsStr, OsString};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, BufRead, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use super::protocol::{Command, ConflictInfo, Event, Op, Policy, Progress, RecycleRoot, Side, Spec, Status};
use crate::fsops::{describe, rename_noreplace};

const EMIT_EVERY: Duration = Duration::from_millis(150);
const CHUNK: usize = 4 * 1024 * 1024;
/// FICLONE, _IOW(0x94, 9, int): same as BTRFS_IOC_CLONE, in every kernel DSM ships.
const FICLONE: libc::c_ulong = 0x4004_9409;

#[derive(Default)]
struct Control {
    paused: bool,
    cancel: bool,
    limit: u64,
    answer: Option<(u64, Policy, bool)>,
    limit_changed: bool,
}

struct Shared {
    state: Mutex<Control>,
    wake: Condvar,
}

/// Stops the whole job; per-item failures are recorded and skipped.
struct Cancelled;

type Step<T> = Result<T, Cancelled>;

pub fn run() -> std::process::ExitCode {
    let stdin = io::stdin();
    let mut first = String::new();
    if stdin.lock().read_line(&mut first).is_err() {
        return std::process::ExitCode::FAILURE;
    }
    let spec: Spec = match serde_json::from_str(&first) {
        Ok(spec) => spec,
        Err(e) => {
            emit(&Event::Done { status: Status::Failed, msg: t!("richiesta non valida: {}", "invalid request: {}", e) });
            return std::process::ExitCode::FAILURE;
        }
    };
    crate::lang::set(&spec.lang);
    let shared = Arc::new(Shared { state: Mutex::new(Control { limit: spec.limit, ..Default::default() }), wake: Condvar::new() });
    let reader = Arc::clone(&shared);
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let Ok(cmd) = serde_json::from_str::<Command>(&line) else { continue };
            let mut s = reader.state.lock().unwrap();
            match cmd {
                Command::Pause => s.paused = true,
                Command::Resume => s.paused = false,
                Command::Cancel => s.cancel = true,
                Command::Limit { bps } => {
                    s.limit = bps;
                    s.limit_changed = true;
                }
                Command::Answer { id, action, all } => s.answer = Some((id, action, all)),
            }
            reader.wake.notify_all();
        }
        // the daemon went away: nobody can answer or watch, stop cleanly
        let mut s = reader.state.lock().unwrap();
        s.cancel = true;
        reader.wake.notify_all();
    });

    let mut engine = Engine::new(spec, shared);
    let (status, msg) = match engine.run() {
        Ok(()) => (Status::Ok, engine.summary()),
        Err(Cancelled) => {
            // deepest first; remove_dir leaves any folder that holds something
            for dir in engine.made_dirs.iter().rev() {
                let _ = fs::remove_dir(dir);
            }
            (Status::Cancelled, t!("annullato", "cancelled").to_string())
        }
    };
    let status = if status == Status::Ok && engine.fatal.is_some() { Status::Failed } else { status };
    let msg = engine.fatal.take().unwrap_or(msg);
    engine.emit_progress(true);
    emit(&Event::Done { status, msg });
    std::process::ExitCode::SUCCESS
}

fn emit(event: &Event) {
    let mut out = io::stdout().lock();
    let _ = serde_json::to_writer(&mut out, event);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

struct Engine {
    spec: Spec,
    shared: Arc<Shared>,
    p: Progress,
    last_emit: Instant,
    apply_all: Option<Policy>,
    conflicts: u64,
    /// folder the sources live in: progress names are relative to it
    base: PathBuf,
    window: (Instant, u64),
    buf: Vec<u8>,
    clone_works: Option<bool>,
    fatal: Option<String>,
    /// folders this job made: on cancel the ones left empty go
    made_dirs: Vec<PathBuf>,
}

impl Engine {
    fn new(spec: Spec, shared: Arc<Shared>) -> Self {
        let base = spec.sources.first().and_then(|s| s.parent()).map(Path::to_path_buf).unwrap_or_default();
        Self {
            spec,
            shared,
            p: Progress::default(),
            last_emit: Instant::now() - EMIT_EVERY,
            apply_all: None,
            conflicts: 0,
            base,
            window: (Instant::now(), 0),
            buf: Vec::new(),
            clone_works: None,
            fatal: None,
            made_dirs: Vec::new(),
        }
    }

    fn display(&self, path: &Path) -> String {
        path.strip_prefix(&self.base).unwrap_or(path).to_string_lossy().into_owned()
    }

    fn emit_progress(&mut self, force: bool) {
        if force || self.last_emit.elapsed() >= EMIT_EVERY {
            self.last_emit = Instant::now();
            emit(&Event::Progress(self.p.clone()));
        }
    }

    fn error(&mut self, path: &Path, e: &io::Error) {
        self.error_msg(path, describe(e));
    }

    fn error_msg(&mut self, path: &Path, msg: String) {
        self.p.errors += 1;
        emit(&Event::Error { path: self.display(path), msg });
    }

    /// Between two chunks: honours pause, cancel and the speed limit, and
    /// reports progress now and then.
    fn checkpoint(&mut self) -> Step<()> {
        let mut paused_here = false;
        {
            let mut s = self.shared.state.lock().unwrap();
            loop {
                if s.cancel {
                    return Err(Cancelled);
                }
                if !s.paused {
                    break;
                }
                if !self.p.paused {
                    self.p.paused = true;
                    drop(s);
                    self.emit_progress(true);
                    s = self.shared.state.lock().unwrap();
                }
                paused_here = true;
                s = self.shared.wake.wait_timeout(s, Duration::from_millis(500)).unwrap().0;
            }
            if s.limit_changed {
                s.limit_changed = false;
                paused_here = true;
            }
        }
        if paused_here {
            self.p.paused = false;
            self.window = (Instant::now(), 0);
            self.emit_progress(true);
        }
        self.throttle()?;
        self.emit_progress(false);
        Ok(())
    }

    fn throttle(&mut self) -> Step<()> {
        loop {
            let limit = self.shared.state.lock().unwrap().limit;
            if limit == 0 {
                return Ok(());
            }
            let due = Duration::from_secs_f64(self.window.1 as f64 / limit as f64);
            let elapsed = self.window.0.elapsed();
            if due <= elapsed {
                // a fresh window every few seconds keeps a change of limit quick to take effect
                if elapsed > Duration::from_secs(3) {
                    self.window = (Instant::now(), 0);
                }
                return Ok(());
            }
            std::thread::sleep((due - elapsed).min(Duration::from_millis(200)));
            if self.shared.state.lock().unwrap().cancel {
                return Err(Cancelled);
            }
            self.emit_progress(false);
        }
    }

    fn advance(&mut self, n: u64) {
        self.p.bytes_done += n;
        self.p.current_done += n;
        self.window.1 += n;
    }

    fn run(&mut self) -> Step<()> {
        match self.spec.op {
            Op::Delete => self.delete(),
            Op::Copy | Op::Move => self.transfer(),
            Op::Compress => self.compress(),
            Op::Extract => self.extract(),
            Op::Cleanup => {
                self.cleanup();
                Ok(())
            }
        }
    }

    /// The leftovers of a job the restart cut short: ".name.synofile-part"
    /// files and ".synofile-x-…" extraction folders, in the destination and
    /// in the trees it was copying into. Nothing else is touched.
    fn cleanup(&mut self) {
        let Some(dest) = self.spec.dest.clone() else { return };
        let leftover = |name: &OsStr| {
            let b = name.as_bytes();
            (b.starts_with(b".") && b.ends_with(b".synofile-part")) || b.starts_with(b".synofile-x-")
        };
        let clean = |dir: &Path, deep: bool, stack: &mut Vec<PathBuf>, seen: &mut usize| {
            let Ok(items) = fs::read_dir(dir) else { return };
            for item in items.flatten() {
                *seen += 1;
                let name = item.file_name();
                let Ok(kind) = item.file_type() else { continue };
                if leftover(&name) {
                    let _ = if kind.is_dir() { fs::remove_dir_all(item.path()) } else { fs::remove_file(item.path()) };
                } else if deep && kind.is_dir() {
                    stack.push(item.path());
                }
            }
        };
        let mut seen = 0usize;
        let mut stack = Vec::new();
        // the destination at its top level, the trees of the job's items in full
        clean(&dest, false, &mut stack, &mut seen);
        for src in &self.spec.sources {
            if let Some(name) = src.file_name() {
                stack.push(dest.join(name));
            }
        }
        while let Some(dir) = stack.pop() {
            if seen > 500_000 {
                return;
            }
            clean(&dir, true, &mut stack, &mut seen);
        }
    }

    fn summary(&self) -> String {
        let mut parts = vec![];
        if self.p.skipped > 0 {
            parts.push(t!("{} saltati", "{} skipped", self.p.skipped));
        }
        if self.p.errors > 0 {
            parts.push(t!("{} errori", "{} errors", self.p.errors));
        }
        if parts.is_empty() { t!("completato", "complete").into() } else { t!("completato: {}", "complete: {}", parts.join(", ")) }
    }

    // ---- copy and move ----

    fn transfer(&mut self) -> Step<()> {
        let Some(dest) = self.spec.dest.clone() else {
            self.fatal = Some(t!("manca la destinazione", "no destination").into());
            return Ok(());
        };
        let moving = self.spec.op == Op::Move;
        let sources = self.spec.sources.clone();

        if !self.can_write(&dest) {
            return Ok(());
        }
        // refuse a folder into itself before touching anything
        let dest_real = fs::canonicalize(&dest).unwrap_or_else(|_| dest.clone());
        for src in &sources {
            let src_real = fs::canonicalize(src).unwrap_or_else(|_| src.clone());
            if fs::symlink_metadata(src).is_ok_and(|m| m.is_dir()) && dest_real.starts_with(&src_real) {
                self.fatal = Some(t!("non si può copiare o spostare «{}» dentro sé stessa", "“{}” cannot be copied or moved into itself", self.display(src)));
                return Ok(());
            }
        }

        // moves inside one subvolume are renames: no scan, no data
        let mut slow = Vec::new();
        if moving {
            self.p.phase = "move".into();
            self.p.method = "rename".into();
            self.p.files_total = sources.len() as u64;
            for src in sources {
                self.checkpoint()?;
                let Some(name) = src.file_name().map(OsStr::to_os_string) else { continue };
                let target = dest.join(&name);
                if src == target {
                    self.p.skipped += 1;
                    self.p.files_done += 1;
                    continue;
                }
                self.p.current = self.display(&src);
                match rename_noreplace(&src, &target) {
                    Ok(()) => {
                        self.p.files_done += 1;
                        self.p.instant += 1;
                    }
                    Err(e) if e.raw_os_error() == Some(libc::EXDEV) || e.kind() == io::ErrorKind::AlreadyExists => {
                        slow.push(src)
                    }
                    Err(e) => {
                        self.error(&src, &e);
                        self.p.files_done += 1;
                    }
                }
            }
            if slow.is_empty() {
                return Ok(());
            }
            // what is left is counted again by the scan
            self.p.files_total = self.p.files_done;
        } else {
            slow = sources;
        }

        self.scan(&slow)?;
        if !self.room_for(&slow, &dest) {
            return Ok(());
        }
        self.p.phase = if moving { "move" } else { "copy" }.into();
        for src in slow {
            let Some(name) = src.file_name().map(OsStr::to_os_string) else { continue };
            self.item(&src, &dest, &name, moving, true)?;
        }
        self.p.current.clear();
        self.p.current_size = 0;
        self.p.current_done = 0;
        Ok(())
    }

    fn scan(&mut self, sources: &[PathBuf]) -> Step<()> {
        self.p.phase = "scan".into();
        self.p.scanning = true;
        let mut stack: Vec<PathBuf> = sources.to_vec();
        let mut seen = 0u64;
        while let Some(path) = stack.pop() {
            seen += 1;
            if seen % 512 == 0 {
                self.checkpoint()?;
            }
            let Ok(meta) = fs::symlink_metadata(&path) else { continue };
            if meta.is_dir() {
                self.p.dirs += 1;
                if let Ok(rd) = fs::read_dir(&path) {
                    stack.extend(rd.flatten().map(|e| e.path()));
                }
            } else {
                self.p.files_total += 1;
                if meta.is_file() {
                    self.p.bytes_total += meta.len();
                }
            }
        }
        self.p.scanning = false;
        self.emit_progress(true);
        Ok(())
    }

    /// Fails the job at once when the user may not write into `dest`: else
    /// every item would fail on its own, after the whole scan.
    fn can_write(&mut self, dest: &Path) -> bool {
        if crate::fsops::access(dest, libc::W_OK | libc::X_OK) {
            return true;
        }
        let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| dest.display().to_string());
        self.fatal = Some(t!("non hai il permesso di scrivere nella cartella «{}»", "you are not allowed to write to the folder “{}”", name));
        false
    }

    /// Fails the job early when the data cannot fit. A copy inside one
    /// btrfs mount may become clones that take no room, so it is let go.
    fn room_for(&mut self, sources: &[PathBuf], dest: &Path) -> bool {
        let Some((free, _)) = crate::fsops::space(dest) else { return true };
        if free >= self.p.bytes_total {
            return true;
        }
        let mounts = fs::read_to_string("/proc/self/mounts").unwrap_or_default();
        let target = mount_of(&mounts, dest);
        let all_clonable = sources.iter().all(|s| {
            let m = mount_of(&mounts, s);
            m.is_some() && m == target && target.as_ref().is_some_and(|t| t.1 == "btrfs")
        });
        if all_clonable && !self.spec.verify {
            return true;
        }
        self.fatal = Some(t!(
            "spazio insufficiente: servono {}, liberi {}",
            "not enough space: {} needed, {} free",
            human(self.p.bytes_total),
            human(free)
        ));
        false
    }

    /// One item of the tree: `src` lands in `dest_dir` as `name`.
    fn item(&mut self, src: &Path, dest_dir: &Path, name: &OsStr, moving: bool, top: bool) -> Step<()> {
        self.checkpoint()?;
        let meta = match fs::symlink_metadata(src) {
            Ok(meta) => meta,
            Err(e) => {
                self.error(src, &e);
                return Ok(());
            }
        };
        let mut target = dest_dir.join(name);
        if top && !moving && target == src {
            // copy onto itself: keep both, the way every file manager does
            target = unique_name(dest_dir, name, &t!(" - Copia", " - Copy"));
        }
        self.p.current = self.display(src);
        self.p.current_size = if meta.is_file() { meta.len() } else { 0 };
        self.p.current_done = 0;

        let existing = fs::symlink_metadata(&target).ok();
        if meta.is_dir() {
            return self.dir(src, &meta, &target, existing, moving);
        }
        let mut replace = false;
        if let Some(old) = existing {
            match self.decide(src, &meta, &target, &old)? {
                Decision::Skip => {
                    self.skip(&meta);
                    return Ok(());
                }
                Decision::Rename(other) => target = other,
                Decision::Overwrite => {
                    if old.is_dir() {
                        self.error_msg(src, t!("al suo posto c'è una cartella con lo stesso nome", "a folder with the same name is in its place").into());
                        self.skip(&meta);
                        return Ok(());
                    }
                    replace = true;
                }
            }
        }
        if moving {
            match fs::rename(src, &target) {
                Ok(()) => {
                    self.p.method = "rename".into();
                    self.p.instant += 1;
                    self.p.files_done += 1;
                    self.advance(if meta.is_file() { meta.len() } else { 0 });
                    return Ok(());
                }
                Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {}
                Err(e) => {
                    self.error(src, &e);
                    self.skip(&meta);
                    return Ok(());
                }
            }
        }
        let t = meta.file_type();
        let result = if t.is_file() {
            self.file(src, &meta, &target)
        } else if t.is_symlink() {
            fs::read_link(src).and_then(|link| {
                if replace {
                    let _ = fs::remove_file(&target);
                }
                std::os::unix::fs::symlink(link, &target)
            })
        } else {
            Err(io::Error::other(t!("file speciale (dispositivo, socket o pipe): saltato", "special file (device, socket or pipe): skipped")))
        };
        match result {
            Ok(()) => {
                self.p.files_done += 1;
                if moving {
                    if let Err(e) = fs::remove_file(src) {
                        self.error_msg(src, t!("copiato, ma l'originale non si cancella: {}", "copied, but the original cannot be deleted: {}", describe(&e)));
                    }
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => return Err(Cancelled),
            Err(e) => {
                self.error(src, &e);
                self.p.files_done += 1;
            }
        }
        Ok(())
    }

    fn skip(&mut self, meta: &Metadata) {
        self.p.skipped += 1;
        self.p.files_done += 1;
        if meta.is_file() {
            // skipped bytes count as handled, so the bar and the time left stay true
            self.p.bytes_done += meta.len();
        }
    }

    fn dir(&mut self, src: &Path, meta: &Metadata, target: &Path, existing: Option<Metadata>, moving: bool) -> Step<()> {
        let mut target = target.to_path_buf();
        match existing {
            Some(old) if old.is_dir() => {} // merge into it
            Some(old) => match self.decide(src, meta, &target, &old)? {
                Decision::Skip => {
                    self.skip_tree(src);
                    return Ok(());
                }
                Decision::Rename(other) => target = other,
                Decision::Overwrite => {
                    if let Err(e) = fs::remove_file(&target) {
                        self.error(src, &e);
                        self.skip_tree(src);
                        return Ok(());
                    }
                }
            },
            None => {
                if moving {
                    match fs::rename(src, &target) {
                        Ok(()) => {
                            // the scan counted it: credit the whole tree at once
                            self.p.method = "rename".into();
                            self.credit_tree(&target);
                            return Ok(());
                        }
                        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {}
                        Err(e) => {
                            self.error(src, &e);
                            self.skip_tree(src);
                            return Ok(());
                        }
                    }
                }
            }
        }
        let created = fs::symlink_metadata(&target).is_err();
        if created {
            if let Err(e) = fs::create_dir(&target) {
                self.error(src, &e);
                self.skip_tree(src);
                return Ok(());
            }
            self.made_dirs.push(target.clone());
        }
        let mut children: Vec<OsString> = match fs::read_dir(src) {
            Ok(rd) => rd.flatten().map(|e| e.file_name()).collect(),
            Err(e) => {
                self.error(src, &e);
                return Ok(());
            }
        };
        children.sort();
        for child in children {
            self.item(&src.join(&child), &target, &child, moving, false)?;
        }
        if created {
            set_times(&target, meta);
        }
        if moving {
            // a skipped or failed child keeps the source folder: that is right
            let _ = fs::remove_dir(src);
        }
        Ok(())
    }

    fn walk_counts(path: &Path) -> (u64, u64) {
        let (mut files, mut bytes) = (0, 0);
        let mut stack = vec![path.to_path_buf()];
        while let Some(p) = stack.pop() {
            let Ok(m) = fs::symlink_metadata(&p) else { continue };
            if m.is_dir() {
                if let Ok(rd) = fs::read_dir(&p) {
                    stack.extend(rd.flatten().map(|e| e.path()));
                }
            } else {
                files += 1;
                if m.is_file() {
                    bytes += m.len();
                }
            }
        }
        (files, bytes)
    }

    fn credit_tree(&mut self, path: &Path) {
        let (files, bytes) = Self::walk_counts(path);
        self.p.files_done += files;
        self.p.instant += files;
        self.p.bytes_done += bytes;
    }

    fn skip_tree(&mut self, path: &Path) {
        let (files, bytes) = Self::walk_counts(path);
        self.p.files_done += files;
        self.p.skipped += files;
        self.p.bytes_done += bytes;
    }

    fn decide(&mut self, src: &Path, meta: &Metadata, target: &Path, old: &Metadata) -> Step<Decision> {
        let dir = target.parent().unwrap_or(Path::new("/"));
        let name = target.file_name().unwrap_or_default();
        let policy = match self.apply_all.unwrap_or(self.spec.conflict) {
            Policy::Ask => self.ask(src, meta, target, old)?,
            p => p,
        };
        Ok(match policy {
            Policy::Skip => Decision::Skip,
            Policy::Overwrite => Decision::Overwrite,
            Policy::Rename | Policy::Ask => Decision::Rename(unique_name(dir, name, "")),
            Policy::Newer => {
                if meta.mtime() > old.mtime() {
                    Decision::Overwrite
                } else {
                    Decision::Skip
                }
            }
        })
    }

    /// Asks the user through the daemon, and waits.
    fn ask(&mut self, src: &Path, meta: &Metadata, target: &Path, old: &Metadata) -> Step<Policy> {
        self.conflicts += 1;
        let id = self.conflicts;
        let dir = target.parent().unwrap_or(Path::new("/"));
        let name = target.file_name().unwrap_or_default();
        let info = ConflictInfo {
            id,
            name: name.to_string_lossy().into_owned(),
            path: self.display(src),
            source: Side { size: meta.len(), mtime: meta.mtime(), dir: meta.is_dir() },
            target: Side { size: old.len(), mtime: old.mtime(), dir: old.is_dir() },
            rename_to: unique_name(dir, name, "").file_name().unwrap_or_default().to_string_lossy().into_owned(),
        };
        self.emit_progress(true);
        emit(&Event::Conflict(info));
        let mut s = self.shared.state.lock().unwrap();
        loop {
            if s.cancel {
                return Err(Cancelled);
            }
            if let Some((answer_id, action, all)) = s.answer.take() {
                if answer_id == id {
                    drop(s);
                    if all {
                        self.apply_all = Some(action);
                    }
                    // the time spent waiting is not transfer time
                    self.window = (Instant::now(), 0);
                    return Ok(if action == Policy::Ask { Policy::Rename } else { action });
                }
            }
            s = self.shared.wake.wait_timeout(s, Duration::from_millis(500)).unwrap().0;
        }
    }

    fn file(&mut self, src: &Path, meta: &Metadata, target: &Path) -> io::Result<()> {
        let dir = target.parent().unwrap_or(Path::new("/"));
        let part = dir.join(part_name(target.file_name().unwrap_or_default()));
        let input = File::open(src)?;
        let _ = fs::remove_file(&part);
        let output = OpenOptions::new().write(true).create_new(true).mode(0o666).open(&part)?;
        let result = self.fill(&input, &output, meta.len(), &part);
        let result = result.and_then(|()| {
            set_file_times(&output, meta);
            drop(output);
            fs::rename(&part, target)
        });
        if result.is_err() {
            let _ = fs::remove_file(&part);
        }
        result
    }

    fn fill(&mut self, input: &File, output: &File, size: u64, part: &Path) -> io::Result<()> {
        if self.clone_works != Some(false) && !self.spec.verify {
            // SAFETY: two open descriptors
            let rc = unsafe { libc::ioctl(output.as_raw_fd(), FICLONE as _, input.as_raw_fd()) };
            if rc == 0 {
                self.clone_works = Some(true);
                self.p.method = "clone".into();
                self.p.instant += 1;
                self.advance(size);
                return Ok(());
            }
            let e = io::Error::last_os_error();
            match e.raw_os_error() {
                Some(libc::EXDEV) | Some(libc::EOPNOTSUPP) | Some(libc::EINVAL) | Some(libc::ENOTTY) | Some(libc::EPERM) => {
                    // other volume, or a filesystem without reflinks: stream the bytes
                    if self.clone_works.is_none() {
                        self.clone_works = Some(false);
                    }
                }
                _ => return Err(e),
            }
        }
        // SAFETY: an open descriptor; advice only
        unsafe { libc::posix_fadvise(input.as_raw_fd(), 0, 0, libc::POSIX_FADV_SEQUENTIAL) };
        self.p.method = "copy".into();
        if self.spec.verify {
            return self.fill_verified(input, output, size, part);
        }
        let mut left = size;
        while left > 0 {
            let want = left.min(CHUNK as u64) as usize;
            // SAFETY: two open descriptors, offset taken from the input
            let n = unsafe { libc::sendfile(output.as_raw_fd(), input.as_raw_fd(), std::ptr::null_mut(), want) };
            if n < 0 {
                let e = io::Error::last_os_error();
                if matches!(e.raw_os_error(), Some(libc::EINVAL) | Some(libc::ENOSYS)) && left == size {
                    return self.fill_plain(input, output, size);
                }
                if e.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(e);
            }
            if n == 0 {
                // the file shrank while we copied it
                break;
            }
            left -= n as u64;
            self.advance(n as u64);
            if self.checkpoint().is_err() {
                return Err(io::Error::from(io::ErrorKind::Interrupted));
            }
        }
        Ok(())
    }

    fn fill_plain(&mut self, mut input: &File, mut output: &File, _size: u64) -> io::Result<()> {
        if self.buf.len() != CHUNK {
            self.buf = vec![0; CHUNK];
        }
        loop {
            let n = input.read(&mut self.buf)?;
            if n == 0 {
                return Ok(());
            }
            output.write_all(&self.buf[..n])?;
            self.advance(n as u64);
            if self.checkpoint().is_err() {
                return Err(io::Error::from(io::ErrorKind::Interrupted));
            }
        }
    }

    /// Copies while hashing, then reads the copy back and compares.
    fn fill_verified(&mut self, mut input: &File, mut output: &File, size: u64, part: &Path) -> io::Result<()> {
        if self.buf.len() != CHUNK {
            self.buf = vec![0; CHUNK];
        }
        let mut hash = xxhash_rust::xxh3::Xxh3::new();
        loop {
            let n = input.read(&mut self.buf)?;
            if n == 0 {
                break;
            }
            hash.update(&self.buf[..n]);
            output.write_all(&self.buf[..n])?;
            self.advance(n as u64);
            if self.checkpoint().is_err() {
                return Err(io::Error::from(io::ErrorKind::Interrupted));
            }
        }
        output.sync_data()?;
        // SAFETY: drop the copy from the page cache, so the check reads the disk
        unsafe { libc::posix_fadvise(output.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
        let phase = std::mem::replace(&mut self.p.phase, "verify".into());
        self.p.current_done = 0;
        self.p.current_size = size;
        let mut check = xxhash_rust::xxh3::Xxh3::new();
        let mut back = File::open(part)?;
        loop {
            let n = back.read(&mut self.buf)?;
            if n == 0 {
                break;
            }
            check.update(&self.buf[..n]);
            self.p.verify_bytes += n as u64;
            self.p.current_done += n as u64;
            if self.checkpoint().is_err() {
                return Err(io::Error::from(io::ErrorKind::Interrupted));
            }
        }
        self.p.phase = phase;
        if check.digest128() != hash.digest128() {
            return Err(io::Error::other(t!("verifica fallita: la copia è diversa dall'originale", "verification failed: the copy differs from the original")));
        }
        Ok(())
    }

    // ---- archives ----

    fn compress(&mut self) -> Step<()> {
        let Some(dest) = self.spec.dest.clone() else {
            self.fatal = Some(t!("manca la destinazione", "no destination"));
            return Ok(());
        };
        let sources = self.spec.sources.clone();
        let level = crate::zip::Level::parse(self.spec.level.as_deref().unwrap_or("normal"));
        let mut name = self.spec.name.clone().unwrap_or_else(|| t!("Archivio.zip", "Archive.zip"));
        if !name.to_ascii_lowercase().ends_with(".zip") {
            name.push_str(".zip");
        }
        if !self.can_write(&dest) {
            return Ok(());
        }
        self.scan(&sources)?;
        if !self.room_for(&[], &dest) {
            return Ok(());
        }
        self.p.phase = "compress".into();
        self.p.method = if level == crate::zip::Level::Store { "store".into() } else { "deflate".into() };
        let mut target = dest.join(&name);
        if fs::symlink_metadata(&target).is_ok() {
            target = unique_name(&dest, OsStr::new(&name), "");
        }
        let part = dest.join(part_name(target.file_name().unwrap_or_default()));
        let file = match OpenOptions::new().write(true).create_new(true).mode(0o666).open(&part) {
            Ok(f) => f,
            Err(e) => {
                self.fatal = Some(describe(&e));
                return Ok(());
            }
        };
        let mut zip = crate::zip::ZipWriter::new(io::BufWriter::with_capacity(1 << 20, file));
        let result = self.zip_sources(&mut zip, &sources, level, &target);
        let result = match result {
            Ok(()) => zip.finish().and_then(|w| w.into_inner().map_err(|e| e.into_error())).map(drop),
            Err(e) => Err(e),
        };
        match result {
            Ok(()) => {
                if let Err(e) = fs::rename(&part, &target) {
                    let _ = fs::remove_file(&part);
                    self.fatal = Some(describe(&e));
                }
                self.p.current.clear();
                Ok(())
            }
            Err(e) => {
                let _ = fs::remove_file(&part);
                if e.kind() == io::ErrorKind::Interrupted {
                    return Err(Cancelled);
                }
                self.fatal = Some(describe(&e));
                Ok(())
            }
        }
    }

    fn zip_sources<W: Write>(&mut self, zip: &mut crate::zip::ZipWriter<W>, sources: &[PathBuf], level: crate::zip::Level, target: &Path) -> io::Result<()> {
        let mut stack: Vec<PathBuf> = sources.iter().rev().cloned().collect();
        while let Some(path) = stack.pop() {
            if path == target {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(&path) else { continue };
            let name = self.display(&path);
            self.p.current = name.clone();
            self.p.current_size = if meta.is_file() { meta.len() } else { 0 };
            self.p.current_done = 0;
            let mode = meta.mode();
            if meta.is_dir() {
                zip.add_dir(&name, meta.mtime(), mode)?;
                let mut children: Vec<PathBuf> = match fs::read_dir(&path) {
                    Ok(rd) => rd
                        .flatten()
                        .filter(|e| !crate::fsops::is_system_name(&e.file_name().to_string_lossy()))
                        .map(|e| e.path())
                        .collect(),
                    Err(e) => {
                        self.error(&path, &e);
                        continue;
                    }
                };
                children.sort();
                stack.extend(children.into_iter().rev());
            } else if meta.is_file() {
                let mut file = match File::open(&path) {
                    Ok(f) => f,
                    Err(e) => {
                        self.error(&path, &e);
                        self.skip(&meta);
                        continue;
                    }
                };
                // SAFETY: an open descriptor; advice only
                unsafe { libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_SEQUENTIAL) };
                let mut progress = |n: u64| -> io::Result<()> {
                    self.advance(n);
                    self.checkpoint().map_err(|_| io::Error::from(io::ErrorKind::Interrupted))
                };
                zip.add_file(&name, meta.mtime(), mode, &mut file, level, &mut progress)?;
                self.p.files_done += 1;
            } else if meta.file_type().is_symlink() {
                let link = fs::read_link(&path).map(|l| l.to_string_lossy().into_owned()).unwrap_or_default();
                zip.add_symlink(&name, meta.mtime(), &link)?;
                self.p.files_done += 1;
            } else {
                self.p.files_done += 1;
            }
        }
        Ok(())
    }

    fn extract(&mut self) -> Step<()> {
        let (Some(archive), Some(dest)) = (self.spec.sources.first().cloned(), self.spec.dest.clone()) else {
            self.fatal = Some(t!("manca la destinazione", "no destination"));
            return Ok(());
        };
        if !self.can_write(&dest) {
            return Ok(());
        }
        let size = fs::metadata(&archive).map(|m| m.len()).unwrap_or(0);
        self.p.phase = "extract".into();
        self.p.bytes_total = size;
        self.p.files_total = 0;
        let name = archive.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let rar = name.to_ascii_lowercase().ends_with(".rar");
        self.p.method = if rar { "unrar".into() } else { "7z".into() };
        let mut created = None;
        let target = if self.spec.into_folder {
            let dir = unique_name(&dest, OsStr::new(archive_stem(&name)), "");
            if let Err(e) = fs::create_dir(&dir) {
                self.fatal = Some(describe(&e));
                return Ok(());
            }
            created = Some(dir.clone());
            dir
        } else {
            dest.clone()
        };
        let password = self.spec.password.clone().unwrap_or_default();
        let policy = self.spec.conflict;
        let format = crate::archive::format(&name);
        // Everything lands in a hidden folder first, then moves into place
        // under the conflict rule: the same for every tool, and it lets a
        // few items come out of the archive on their own.
        let tmp = target.join(format!(".synofile-x-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        if let Err(e) = fs::create_dir(&tmp) {
            if let Some(dir) = &created {
                let _ = fs::remove_dir(dir);
            }
            self.fatal = Some(describe(&e));
            return Ok(());
        }
        let cleanup = |created: &Option<PathBuf>| {
            let _ = fs::remove_dir_all(&tmp);
            let _ = fs::remove_file(tmp.with_extension("list"));
            if let Some(dir) = created {
                let _ = fs::remove_dir_all(dir);
            }
        };
        // only some items: the tools get the list of their names in a file
        let list = if self.spec.members.is_empty() {
            None
        } else {
            let all = match crate::archive::members(&archive) {
                Ok(m) => m,
                Err(e) => {
                    cleanup(&created);
                    self.fatal = Some(e.message);
                    return Ok(());
                }
            };
            let wanted: Vec<&crate::archive::Member> = all
                .iter()
                .filter(|m| self.spec.members.iter().any(|sel| m.path == *sel || (m.path.starts_with(sel.as_str()) && m.path.as_bytes().get(sel.len()) == Some(&b'/'))))
                .collect();
            self.p.bytes_total = wanted.iter().map(|m| m.size).sum();
            self.p.files_total = wanted.iter().filter(|m| !m.dir).count() as u64;
            let file = tmp.with_extension("list");
            let text: String = wanted.iter().map(|m| format!("{}\n", m.raw)).collect();
            if let Err(e) = fs::write(&file, text) {
                cleanup(&created);
                self.fatal = Some(describe(&e));
                return Ok(());
            }
            Some(file)
        };
        let fed = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let tar = matches!(format, Some(crate::archive::Format::Tar(_)));
        let mut cmd = match format {
            Some(crate::archive::Format::Rar) => {
                let mut c = std::process::Command::new("unrar");
                c.arg("x").arg("-o+");
                c.arg(if password.is_empty() { "-p-".to_string() } else { format!("-p{password}") });
                // a list after "--" would be taken for a file name
                if let Some(l) = &list {
                    c.arg(format!("-n@{}", l.display()));
                }
                c.arg("--").arg(&archive).arg(format!("{}/", tmp.display()));
                c
            }
            Some(crate::archive::Format::Tar(flag)) => {
                // fed through stdin, so the bytes read give the progress
                let mut c = std::process::Command::new("tar");
                c.args(["-x", "-v", "--no-same-owner", "--no-same-permissions"]);
                if let Some(f) = flag {
                    c.arg(f);
                }
                c.arg("-f").arg("-").arg("-C").arg(&tmp);
                if let Some(l) = &list {
                    c.args(["--no-recursion", "--verbatim-files-from", "-T"]).arg(l);
                }
                c
            }
            _ => {
                let mut c = std::process::Command::new("7z");
                c.arg("x").arg("-y").arg("-bsp1").arg("-bb1").arg("-bse1").arg("-aoa").arg("-spd").arg("-scsUTF-8");
                // the password goes on stdin, out of sight of `ps`; an empty
                // -p makes 7z fail at once instead of asking
                if password.is_empty() {
                    c.arg("-p");
                }
                // a list after "--" would be taken for a file name
                if let Some(l) = &list {
                    c.arg(format!("-i@{}", l.display()));
                }
                c.arg(format!("-o{}", tmp.display())).arg("--").arg(&archive);
                c
            }
        };
        // p7zip reads UTF-8 names right only in a UTF-8 locale
        cmd.env("LC_ALL", "en_US.utf8").env("LANG", "en_US.utf8").env("PATH", "/usr/bin:/bin:/usr/local/bin");
        let password_on_stdin = !tar && format != Some(crate::archive::Format::Rar) && !password.is_empty();
        cmd.stdin(if tar || password_on_stdin { std::process::Stdio::piped() } else { std::process::Stdio::null() });
        cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                cleanup(&created);
                self.fatal = Some(t!("strumento di estrazione non disponibile: {}", "extraction tool not available: {}", describe(&e)));
                return Ok(());
            }
        };
        if password_on_stdin {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(format!("{password}\n").as_bytes());
            }
        }
        let feeder = child.stdin.take().map(|mut stdin| {
            let fed = Arc::clone(&fed);
            let archive = archive.clone();
            std::thread::spawn(move || {
                let Ok(mut f) = File::open(&archive) else { return };
                let mut buf = vec![0u8; 1 << 20];
                while let Ok(n) = f.read(&mut buf) {
                    if n == 0 || stdin.write_all(&buf[..n]).is_err() {
                        break;
                    }
                    fed.fetch_add(n as u64, std::sync::atomic::Ordering::Relaxed);
                }
            })
        });
        #[derive(Default)]
        struct Seen {
            percent: u64,
            files: u64,
            last: String,
            tail: Vec<String>,
            password: bool,
        }
        let seen = Arc::new(Mutex::new(Seen::default()));
        let mut readers = Vec::new();
        for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)].into_iter().flatten() {
            let seen = Arc::clone(&seen);
            readers.push(std::thread::spawn(move || {
                let tar = tar;
                let mut stream = stream;
                let mut line = Vec::new();
                let mut byte = [0u8; 4096];
                let take = |line: &mut Vec<u8>| {
                    let text = String::from_utf8_lossy(line).trim().to_string();
                    line.clear();
                    if text.is_empty() {
                        return;
                    }
                    let mut s = seen.lock().unwrap();
                    let low = text.to_ascii_lowercase();
                    if low.contains("wrong password") || low.contains("incorrect password") || low.contains("encrypted archive") || low.contains("password is incorrect") || low.contains("enter password") {
                        s.password = true;
                    }
                    // 7z: " 45% 12 - dir/file"; unrar: "Extracting  dir/file   45%"
                    if let Some(pct) = text.split_whitespace().find_map(|w| w.strip_suffix('%').and_then(|n| n.parse::<u64>().ok())) {
                        s.percent = s.percent.max(pct.min(100));
                    }
                    let file = if tar {
                        // tar -v prints just the names
                        Some(text.clone()).filter(|f| !f.ends_with('/'))
                    } else {
                        text.strip_prefix("- ").map(str::to_string).or_else(|| text.split_once(" - ").map(|(_, f)| f.to_string())).or_else(|| {
                            text.strip_prefix("Extracting").map(|r| r.trim().trim_end_matches(|c: char| c.is_ascii_digit() || c == '%' || c == ' ' || c == '\u{8}').trim().to_string())
                        })
                    };
                    if let Some(f) = file.filter(|f| !f.is_empty() && !f.starts_with("from ")) {
                        if f != s.last {
                            s.files += 1;
                            s.last = f;
                        }
                    }
                    s.tail.push(text);
                    if s.tail.len() > 12 {
                        s.tail.remove(0);
                    }
                };
                while let Ok(n) = stream.read(&mut byte) {
                    if n == 0 {
                        break;
                    }
                    for &b in &byte[..n] {
                        if b == b'\n' || b == b'\r' || b == 8 {
                            take(&mut line);
                        } else {
                            line.push(b);
                        }
                    }
                }
                take(&mut line);
            }));
        }
        let pid = child.id() as libc::pid_t;
        let mut stopped = false;
        let status = loop {
            if let Ok(Some(status)) = child.try_wait() {
                break Some(status);
            }
            let (paused, cancel) = {
                let s = self.shared.state.lock().unwrap();
                (s.paused, s.cancel)
            };
            if cancel {
                // SAFETY: signalling our own child
                unsafe { libc::kill(pid, libc::SIGKILL) };
                let _ = child.wait();
                cleanup(&created);
                return Err(Cancelled);
            }
            if paused != stopped {
                // SAFETY: signalling our own child
                unsafe { libc::kill(pid, if paused { libc::SIGSTOP } else { libc::SIGCONT }) };
                stopped = paused;
                self.p.paused = paused;
                self.emit_progress(true);
            }
            {
                let s = seen.lock().unwrap();
                self.p.bytes_done = if tar { fed.load(std::sync::atomic::Ordering::Relaxed).min(size) * self.p.bytes_total.max(1) / size.max(1) } else { self.p.bytes_total * s.percent / 100 };
                self.p.files_done = s.files;
                self.p.current = s.last.clone();
            }
            self.emit_progress(false);
            std::thread::sleep(Duration::from_millis(150));
        };
        for r in readers {
            let _ = r.join();
        }
        if let Some(f) = feeder {
            let _ = f.join();
        }
        let s = seen.lock().unwrap();
        self.p.files_done = s.files;
        self.p.files_total = self.p.files_total.max(s.files);
        self.p.current.clear();
        let code = status.and_then(|st| st.code()).unwrap_or(-1);
        if s.password && code != 0 {
            cleanup(&created);
            self.fatal = Some(super::protocol::NEED_PASSWORD.into());
            return Ok(());
        }
        // 7z: 1 = warnings (some files), 2+ = fatal; unrar and tar: 0 ok
        let format_7z = !tar && format != Some(crate::archive::Format::Rar);
        if code == 0 || (format_7z && code == 1) {
            if code == 1 {
                self.error_msg(&archive, s.tail.last().cloned().unwrap_or_default());
            }
            drop(s);
            // into place: the chosen items, or all that came out
            let moves: Vec<(PathBuf, PathBuf)> = if self.spec.members.is_empty() {
                fs::read_dir(&tmp).map(|d| d.flatten().map(|e| (e.path(), target.join(e.file_name()))).collect()).unwrap_or_default()
            } else {
                self.spec.members.iter().map(|m| (tmp.join(m), target.join(m.rsplit('/').next().unwrap_or(m)))).collect()
            };
            let picked = !self.spec.members.is_empty();
            for (from, to) in moves {
                if fs::symlink_metadata(&from).is_err() {
                    // the tool said fine, yet the item is not there
                    if picked {
                        self.error_msg(&to, t!("non estratto dall'archivio", "not extracted from the archive"));
                    }
                    continue;
                }
                if let Err(e) = merge(&from, &to, policy) {
                    self.error_msg(&to, describe(&e));
                }
            }
            let _ = fs::remove_dir_all(&tmp);
            let _ = fs::remove_file(tmp.with_extension("list"));
            self.p.bytes_done = self.p.bytes_total;
            return Ok(());
        }
        let why = s.tail.iter().rev().find(|l| l.to_ascii_lowercase().contains("error")).or(s.tail.last()).cloned().unwrap_or_default();
        self.fatal = Some(t!("estrazione non riuscita: {}", "extraction failed: {}", why));
        drop(s);
        // an empty folder is no use to anybody
        cleanup(&created);
        Ok(())
    }

    // ---- delete ----

    fn delete(&mut self) -> Step<()> {
        let sources = self.spec.sources.clone();
        let recycle = self.spec.recycle.clone();
        let mut permanent = Vec::new();
        self.p.phase = "delete".into();
        self.p.files_total = sources.len() as u64;
        for src in sources {
            match recycle_target(&recycle, &src) {
                Some((root, rel)) => {
                    self.p.method = "recycle".into();
                    self.p.current = self.display(&src);
                    self.checkpoint()?;
                    if let Err(e) = to_recycle(&root, &rel, &src) {
                        self.error_msg(&src, e);
                    }
                    self.p.files_done += 1;
                }
                None => {
                    // counted again below, with everything inside
                    self.p.files_total -= 1;
                    permanent.push(src);
                }
            }
        }
        if permanent.is_empty() {
            return Ok(());
        }
        self.p.method = "delete".into();
        // count first, so the bar means something
        self.p.scanning = true;
        let mut total = 0u64;
        let mut stack = permanent.clone();
        while let Some(p) = stack.pop() {
            total += 1;
            if total % 512 == 0 {
                self.p.files_total = total;
                self.checkpoint()?;
            }
            if fs::symlink_metadata(&p).is_ok_and(|m| m.is_dir()) {
                if let Ok(rd) = fs::read_dir(&p) {
                    stack.extend(rd.flatten().map(|e| e.path()));
                }
            }
        }
        self.p.scanning = false;
        self.p.files_total = self.p.files_done + total;
        for src in permanent {
            self.remove_tree(&src)?;
        }
        Ok(())
    }

    fn remove_tree(&mut self, root: &Path) -> Step<()> {
        // (path, children already removed)
        let mut stack = vec![(root.to_path_buf(), false)];
        while let Some((path, expanded)) = stack.pop() {
            self.checkpoint()?;
            let Ok(meta) = fs::symlink_metadata(&path) else {
                self.p.files_done += 1;
                continue;
            };
            if meta.is_dir() && !expanded {
                stack.push((path.clone(), true));
                match fs::read_dir(&path) {
                    Ok(rd) => stack.extend(rd.flatten().map(|e| (e.path(), false))),
                    Err(e) => self.error(&path, &e),
                }
                continue;
            }
            self.p.current = self.display(&path);
            let result = if meta.is_dir() { fs::remove_dir(&path) } else { fs::remove_file(&path) };
            if let Err(e) = result {
                // a folder that kept a failed child says so once, for the child
                if !(meta.is_dir() && e.raw_os_error() == Some(libc::ENOTEMPTY)) {
                    self.error(&path, &e);
                }
            }
            self.p.files_done += 1;
            if meta.is_file() {
                self.p.bytes_done += meta.len();
            }
        }
        Ok(())
    }
}

enum Decision {
    Skip,
    Overwrite,
    Rename(PathBuf),
}

const SYNORECYCLE: &str = "/usr/syno/bin/synorecycle";

/// The share whose recycle bin takes `src`, and the path inside it. Items
/// already in a recycle bin, or in Synology's @eaDir, are deleted for good,
/// as DSM does (SYNORecycleIsPathRecyclable).
fn recycle_target(roots: &[RecycleRoot], src: &Path) -> Option<(RecycleRoot, PathBuf)> {
    // a personal home is reached through a symlink: compare real paths
    let parent = fs::canonicalize(src.parent()?).ok()?;
    let real = parent.join(src.file_name()?);
    roots.iter().find_map(|root| {
        let base = fs::canonicalize(&root.path).unwrap_or_else(|_| root.path.clone());
        let rel = real.strip_prefix(&base).ok()?.to_path_buf();
        let inside_bin = rel.components().any(|c| c.as_os_str() == crate::shares::RECYCLE)
            || rel.components().any(|c| c.as_os_str() == "@eaDir");
        (!rel.as_os_str().is_empty() && !inside_bin).then(|| (root.clone(), rel))
    })
}

/// Hands `src` to DSM's own recycle bin: synorecycle moves it into
/// #recycle with DSM's naming for duplicates (name_HHMMSS.ext), records
/// the deletion time the cleanup policy reads (user.syno.recycle.dtime)
/// and tells DSM about the deletion. It runs as the user, like File
/// Station does. Symlinks are deleted, not kept, as DSM does.
fn to_recycle(root: &RecycleRoot, rel: &Path, src: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(src).map_err(|e| describe(&e))?;
    if !Path::new(SYNORECYCLE).exists() {
        return dev_recycle(root, rel, src).map_err(|e| describe(&e));
    }
    let verb = if meta.is_dir() { "--rmdir" } else { "--unlink" };
    let output = std::process::Command::new(SYNORECYCLE)
        .arg(verb)
        .arg(format!("share={}", root.name))
        .arg(OsString::from_vec([b"rpath=".as_slice(), rel.as_os_str().as_bytes()].concat()))
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| t!("synorecycle non si avvia: {}", "synorecycle does not start: {}", describe(&e)))?;
    // synorecycle answers 0 even when it did nothing (recycle bin off): what counts is the item being gone
    if fs::symlink_metadata(src).is_ok() {
        let said = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if said.is_empty() { t!("il cestino di DSM non ha accettato l'elemento", "DSM's recycle bin did not take the item").into() } else { t!("cestino di DSM: {}", "DSM recycle bin: {}", said) });
    }
    Ok(())
}

/// Development machines have no DSM: the same layout, done by hand.
fn dev_recycle(root: &RecycleRoot, rel: &Path, src: &Path) -> io::Result<()> {
    let target = root.path.join(crate::shares::RECYCLE).join(rel);
    let parent = target.parent().unwrap_or(&root.path).to_path_buf();
    fs::create_dir_all(&parent)?;
    let mut target = target;
    if fs::symlink_metadata(&target).is_ok() {
        let stamp = chrono_hms();
        let name = target.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let (stem, ext) = match name.rfind('.') {
            Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
            _ => (name.clone(), String::new()),
        };
        target = parent.join(format!("{stem}_{stamp}{ext}"));
        let mut n = 1;
        while fs::symlink_metadata(&target).is_ok() {
            target = parent.join(format!("{stem}_{stamp}_{n}{ext}"));
            n += 1;
        }
    }
    rename_noreplace(src, &target)
}

fn chrono_hms() -> String {
    // SAFETY: localtime_r with valid pointers
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&now, &mut tm);
        format!("{:02}{:02}{:02}", tm.tm_hour, tm.tm_min, tm.tm_sec)
    }
}

/// "Foto.tar.gz" → "Foto", "dati.zip" → "dati"
pub fn archive_stem(name: &str) -> &str {
    let lower = name.to_ascii_lowercase();
    for ext in [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tar.lz", ".tgz", ".tbz2", ".txz"] {
        if lower.ends_with(ext) && name.len() > ext.len() {
            return &name[..name.len() - ext.len()];
        }
    }
    match name.rfind('.') {
        Some(i) if i > 0 => &name[..i],
        _ => name,
    }
}

fn part_name(name: &OsStr) -> OsString {
    // keep the temporary name within 255 bytes
    let bytes = name.as_bytes();
    let mut cut = bytes.len().min(200);
    while cut > 0 && cut < bytes.len() && (bytes[cut] & 0xc0) == 0x80 {
        cut -= 1;
    }
    let mut out = OsString::from(".");
    out.push(OsStr::from_bytes(&bytes[..cut]));
    out.push(".synofile-part");
    out
}

/// "name.ext" if free, else "name (1).ext", "name (2).ext"... With a `tag`,
/// "name - Copia.ext", then "name - Copia (1).ext".
/// Moves an extracted item into place: folders are merged, a clash is
/// settled by the conflict rule (asking is not possible here: "ask" keeps
/// both, like the NAS does).
fn merge(from: &Path, to: &Path, policy: Policy) -> io::Result<()> {
    let Ok(old) = fs::symlink_metadata(to) else { return fs::rename(from, to) };
    let new = fs::symlink_metadata(from)?;
    if old.is_dir() && new.is_dir() {
        for item in fs::read_dir(from)?.flatten() {
            merge(&item.path(), &to.join(item.file_name()), policy)?;
        }
        return Ok(());
    }
    let replace = !old.is_dir()
        && !new.is_dir()
        && match policy {
            Policy::Overwrite => true,
            Policy::Newer => new.mtime() > old.mtime(),
            _ => false,
        };
    if replace {
        return fs::rename(from, to);
    }
    if matches!(policy, Policy::Skip | Policy::Newer | Policy::Overwrite) {
        return Ok(());
    }
    let parent = to.parent().unwrap_or(Path::new("."));
    fs::rename(from, unique_name(parent, to.file_name().unwrap_or_default(), ""))
}

pub fn unique_name(dir: &Path, name: &OsStr, tag: &str) -> PathBuf {
    let text = name.to_string_lossy();
    let (stem, ext) = match text.rfind('.') {
        Some(i) if i > 0 => (&text[..i], &text[i..]),
        _ => (&text[..], ""),
    };
    // the plain name first, when it is free
    let candidate = dir.join(format!("{stem}{tag}{ext}"));
    if fs::symlink_metadata(&candidate).is_err() {
        return candidate;
    }
    (1..)
        .map(|n| dir.join(format!("{stem}{tag} ({n}){ext}")))
        .find(|p| fs::symlink_metadata(p).is_err())
        .unwrap()
}

fn timespec(sec: i64, nsec: i64) -> libc::timespec {
    libc::timespec { tv_sec: sec as _, tv_nsec: nsec as _ }
}

fn set_file_times(file: &File, meta: &Metadata) {
    let times = [timespec(meta.atime(), meta.atime_nsec()), timespec(meta.mtime(), meta.mtime_nsec())];
    // SAFETY: an open descriptor and two timespecs
    unsafe { libc::futimens(file.as_raw_fd(), times.as_ptr()) };
}

fn set_times(path: &Path, meta: &Metadata) {
    let Ok(c) = CString::new(path.as_os_str().as_bytes()) else { return };
    let times = [timespec(meta.atime(), meta.atime_nsec()), timespec(meta.mtime(), meta.mtime_nsec())];
    // SAFETY: a valid C string and two timespecs
    unsafe { libc::utimensat(libc::AT_FDCWD, c.as_ptr(), times.as_ptr(), libc::AT_SYMLINK_NOFOLLOW) };
}

/// The mount a path lives on: (mount point, filesystem type), longest match.
fn mount_of(mounts: &str, path: &Path) -> Option<(PathBuf, String)> {
    mounts
        .lines()
        .filter_map(|line| {
            let mut f = line.split(' ');
            let (_, point, kind) = (f.next()?, f.next()?, f.next()?);
            let point = PathBuf::from(point.replace("\\040", " "));
            path.starts_with(&point).then(|| (point, kind.to_string()))
        })
        .max_by_key(|(p, _)| p.as_os_str().len())
}

pub fn human(bytes: u64) -> String {
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    let mut v = bytes as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 { format!("{bytes} B") } else { format!("{v:.1} {}", UNITS[u]).replace('.', ",") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_names() {
        let dir = std::env::temp_dir().join(format!("synofile-unique-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.txt"), "").unwrap();
        assert_eq!(unique_name(&dir, OsStr::new("a.txt"), ""), dir.join("a (1).txt"));
        fs::write(dir.join("a (1).txt"), "").unwrap();
        assert_eq!(unique_name(&dir, OsStr::new("a.txt"), ""), dir.join("a (2).txt"));
        assert_eq!(unique_name(&dir, OsStr::new("a.txt"), " - Copia"), dir.join("a - Copia.txt"));
        assert_eq!(unique_name(&dir, OsStr::new(".bashrc"), ""), dir.join(".bashrc"));
        fs::write(dir.join(".bashrc"), "").unwrap();
        assert_eq!(unique_name(&dir, OsStr::new(".bashrc"), ""), dir.join(".bashrc (1)"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn part_names_stay_short() {
        let long = "è".repeat(120);
        let part = part_name(OsStr::new(&long));
        assert!(part.len() <= 255);
        assert!(part.to_str().is_some());
    }

    #[test]
    fn finds_mounts() {
        let mounts = "/dev/a / ext4 rw 0 0\n/dev/b /volume1 btrfs rw 0 0\n/dev/c /volume1/x/#snapshot btrfs ro 0 0\n";
        assert_eq!(mount_of(mounts, Path::new("/volume1/Documenti")).unwrap().0, PathBuf::from("/volume1"));
        assert_eq!(mount_of(mounts, Path::new("/volume10")).unwrap().0, PathBuf::from("/"));
    }

    #[test]
    fn human_sizes() {
        assert_eq!(human(512), "512 B");
        assert_eq!(human(1536), "1,5 KB");
        assert_eq!(human(5 * 1024 * 1024 * 1024), "5,0 GB");
    }
}
