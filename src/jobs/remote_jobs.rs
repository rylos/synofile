//! Copies, moves and deletes where a side is a remote connection. The same
//! engine as between shared folders, with each side either the NAS or a
//! server: no reflinks there, a move between two places is a copy and a
//! delete, and deleting on a server is for good (it has no DSM recycle bin).
//!
//! Paths stay `PathBuf`s; a remote one is `/:<id>/…` and goes to its
//! connection.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use super::{CHUNK, Cancelled, ConflictInfo, Decision, Engine, Op, Policy, Side, Step, part_name};
use crate::fsops::describe;
use crate::remote::{self, Fs};

/// What a copy needs to know of an item, on either side.
#[derive(Clone, Copy)]
struct Meta {
    dir: bool,
    file: bool,
    size: u64,
    mtime: i64,
}

impl Meta {
    fn side(&self) -> Side {
        Side { size: self.size, mtime: self.mtime, dir: self.dir }
    }
}

/// One side of a job.
enum End {
    Local,
    Remote(Box<dyn Fs>),
}

fn parts(path: &Path) -> Vec<String> {
    remote::split_path(path).map(|(_, p)| p).unwrap_or_default()
}

fn local_meta(m: &fs::Metadata) -> Meta {
    Meta { dir: m.is_dir(), file: m.is_file(), size: if m.is_file() { m.len() } else { 0 }, mtime: m.mtime() }
}

fn remote_meta(e: &remote::Entry) -> Meta {
    Meta { dir: e.kind == 'd', file: e.kind == 'f', size: e.size, mtime: e.mtime }
}

impl End {
    fn open(path: &Path, conns: &[remote::Conn]) -> io::Result<End> {
        let Some((id, _)) = remote::split_path(path) else { return Ok(End::Local) };
        let conn = conns.iter().find(|c| c.id == id).ok_or_else(|| io::Error::other(t!("connessione inesistente: è stata eliminata?", "no such connection: was it deleted?")))?;
        Ok(End::Remote(conn.connect()?))
    }

    fn stat(&self, p: &Path) -> io::Result<Meta> {
        match self {
            End::Local => fs::symlink_metadata(p).map(|m| local_meta(&m)),
            End::Remote(fs) => fs.stat(&parts(p)).map(|e| remote_meta(&e)),
        }
    }

    /// The items of a folder, sorted by name.
    fn list(&self, p: &Path) -> io::Result<Vec<(String, Meta)>> {
        let mut items: Vec<(String, Meta)> = match self {
            End::Local => fs::read_dir(p)?
                .flatten()
                .filter_map(|e| Some((e.file_name().into_string().ok()?, local_meta(&e.metadata().ok()?))))
                .collect(),
            End::Remote(fs) => fs.list(&parts(p))?.iter().map(|e| (e.name.clone(), remote_meta(e))).collect(),
        };
        items.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(items)
    }

    fn reader(&self, p: &Path) -> io::Result<Box<dyn Read>> {
        Ok(match self {
            End::Local => Box::new(File::open(p)?),
            End::Remote(fs) => Box::new(fs.reader(&parts(p))?),
        })
    }

    fn writer(&self, p: &Path) -> io::Result<Box<dyn remote::Writer>> {
        Ok(match self {
            End::Local => Box::new(LocalWriter(OpenOptions::new().write(true).create_new(true).mode(0o666).open(p)?)),
            End::Remote(fs) => fs.writer(&parts(p), None)?,
        })
    }

    fn mkdir(&self, p: &Path) -> io::Result<()> {
        match self {
            End::Local => fs::create_dir(p),
            End::Remote(fs) => fs.mkdir(&parts(p)),
        }
    }

    fn remove(&self, p: &Path, dir: bool) -> io::Result<()> {
        match self {
            End::Local if dir => fs::remove_dir(p),
            End::Local => fs::remove_file(p),
            End::Remote(fs) => fs.remove(&parts(p), dir),
        }
    }

    /// Never replaces.
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        match self {
            End::Local => crate::fsops::rename_noreplace(from, to),
            End::Remote(fs) => fs.rename(&parts(from), &parts(to)),
        }
    }

    fn set_mtime(&self, p: &Path, mtime: i64) {
        match self {
            End::Local => {
                let Ok(path) = std::ffi::CString::new(p.as_os_str().as_encoded_bytes()) else { return };
                let times = [libc::timespec { tv_sec: 0, tv_nsec: libc::UTIME_OMIT }, libc::timespec { tv_sec: mtime as _, tv_nsec: 0 }];
                // SAFETY: a C string and two timespecs
                unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), libc::AT_SYMLINK_NOFOLLOW) };
            }
            End::Remote(fs) => fs.set_mtime(&parts(p), mtime),
        }
    }

    fn space(&self, p: &Path) -> Option<(u64, u64)> {
        match self {
            End::Local => crate::fsops::space(p),
            End::Remote(fs) => fs.space(&parts(p)),
        }
    }

    /// A free name in `dir`: "name (1).ext", "name (2).ext"…
    fn unique(&self, dir: &Path, name: &str, tag: &str) -> PathBuf {
        let (stem, ext) = match name.rfind('.') {
            Some(i) if i > 0 => (&name[..i], &name[i..]),
            _ => (name, ""),
        };
        let candidate = dir.join(format!("{stem}{tag}{ext}"));
        if self.stat(&candidate).is_err() {
            return candidate;
        }
        (1..).map(|n| dir.join(format!("{stem}{tag} ({n}){ext}"))).find(|p| self.stat(p).is_err()).unwrap()
    }
}

struct LocalWriter(File);

impl Write for LocalWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

impl remote::Writer for LocalWriter {
    fn finish(self: Box<Self>) -> io::Result<()> {
        Ok(())
    }
}

/// The two sides of a transfer.
struct Ends {
    src: End,
    dst: End,
}

impl Engine {
    pub(super) fn remote_run(&mut self) -> Step<()> {
        match self.spec.op {
            Op::Copy | Op::Move => self.r_transfer(),
            Op::Delete => self.r_delete(),
            // nothing of an interrupted copy is cleaned on a server
            Op::Cleanup => Ok(()),
            Op::Compress | Op::Extract => {
                self.fatal = Some(t!("archivi: copia prima i file sul NAS", "archives: copy the files to the NAS first").into());
                Ok(())
            }
        }
    }

    fn connect(&mut self, path: &Path) -> Option<End> {
        match End::open(path, &self.spec.remotes) {
            Ok(end) => Some(end),
            Err(e) => {
                self.fatal = Some(t!("connessione al server non riuscita: {}", "cannot connect to the server: {}", describe(&e)));
                None
            }
        }
    }

    fn r_transfer(&mut self) -> Step<()> {
        let Some(dest) = self.spec.dest.clone() else {
            self.fatal = Some(t!("manca la destinazione", "no destination").into());
            return Ok(());
        };
        let sources = self.spec.sources.clone();
        let moving = self.spec.op == Op::Move;
        let Some(src) = self.connect(&sources[0]) else { return Ok(()) };
        let Some(dst) = self.connect(&dest) else { return Ok(()) };
        let ends = Ends { src, dst };

        match ends.dst.stat(&dest) {
            Ok(m) if m.dir => {}
            Ok(_) => {
                self.fatal = Some(t!("la destinazione non è una cartella", "the destination is not a folder").into());
                return Ok(());
            }
            Err(e) => {
                self.fatal = Some(t!("destinazione: {}", "destination: {}", describe(&e)));
                return Ok(());
            }
        }
        for s in &sources {
            if dest.starts_with(s) && ends.src.stat(s).is_ok_and(|m| m.dir) {
                self.fatal = Some(t!("non si può copiare o spostare «{}» dentro sé stessa", "“{}” cannot be copied or moved into itself", self.display(s)));
                return Ok(());
            }
        }

        // a move inside one server is a rename where the server can
        let same_server = remote::split_path(&sources[0]).map(|x| x.0) == remote::split_path(&dest).map(|x| x.0) && remote::is_remote(&dest);
        let mut slow = Vec::new();
        if moving && same_server {
            self.p.phase = "move".into();
            self.p.method = "rename".into();
            self.p.files_total = sources.len() as u64;
            for s in sources {
                self.checkpoint()?;
                let Some(name) = s.file_name() else { continue };
                let target = dest.join(name);
                self.p.current = self.display(&s);
                match ends.dst.rename(&s, &target) {
                    Ok(()) => {
                        self.p.files_done += 1;
                        self.p.instant += 1;
                    }
                    Err(_) => slow.push(s),
                }
            }
            if slow.is_empty() {
                return Ok(());
            }
            self.p.files_total = self.p.files_done;
        } else {
            slow = sources;
        }

        self.r_scan(&ends, &slow)?;
        if let Some((free, _)) = ends.dst.space(&dest) {
            if free < self.p.bytes_total {
                self.fatal = Some(t!("spazio insufficiente: servono {}, liberi {}", "not enough space: {} needed, {} free", super::human(self.p.bytes_total), super::human(free)));
                return Ok(());
            }
        }
        self.p.phase = if moving { "move" } else { "copy" }.into();
        self.p.method = "copy".into();
        let result = (|| {
            for s in &slow {
                let Some(name) = s.file_name().and_then(|n| n.to_str()).map(String::from) else { continue };
                self.r_item(&ends, s, None, &dest, &name, moving, true)?;
            }
            Ok(())
        })();
        if result.is_err() {
            // the folders this job made and left empty go; remove_dir keeps the others
            for d in std::mem::take(&mut self.made_dirs).iter().rev() {
                let _ = ends.dst.remove(d, true);
            }
        }
        self.p.current.clear();
        self.p.current_size = 0;
        self.p.current_done = 0;
        result
    }

    fn r_scan(&mut self, ends: &Ends, sources: &[PathBuf]) -> Step<()> {
        self.p.phase = "scan".into();
        self.p.scanning = true;
        let mut stack: Vec<(PathBuf, Option<Meta>)> = sources.iter().map(|s| (s.clone(), None)).collect();
        let mut seen = 0u64;
        while let Some((path, meta)) = stack.pop() {
            seen += 1;
            if seen % 64 == 0 {
                self.checkpoint()?;
            }
            let Some(meta) = meta.or_else(|| ends.src.stat(&path).ok()) else { continue };
            if meta.dir {
                self.p.dirs += 1;
                if let Ok(items) = ends.src.list(&path) {
                    stack.extend(items.into_iter().map(|(n, m)| (path.join(n), Some(m))));
                }
            } else {
                self.p.files_total += 1;
                self.p.bytes_total += meta.size;
            }
        }
        self.p.scanning = false;
        self.emit_progress(true);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn r_item(&mut self, ends: &Ends, src: &Path, meta: Option<Meta>, dest_dir: &Path, name: &str, moving: bool, top: bool) -> Step<()> {
        self.checkpoint()?;
        let meta = match meta.map(Ok).unwrap_or_else(|| ends.src.stat(src)) {
            Ok(m) => m,
            Err(e) => {
                self.error(src, &e);
                return Ok(());
            }
        };
        let mut target = dest_dir.join(name);
        if top && !moving && target == src {
            target = ends.dst.unique(dest_dir, name, &t!(" - Copia", " - Copy"));
        }
        self.p.current = self.display(src);
        self.p.current_size = meta.size;
        self.p.current_done = 0;
        let existing = ends.dst.stat(&target).ok();
        if meta.dir {
            return self.r_dir(ends, src, meta, &target, existing, moving);
        }
        if !meta.file {
            self.error_msg(src, t!("collegamento o file speciale: saltato", "link or special file: skipped").into());
            self.r_skip(meta);
            return Ok(());
        }
        let mut replace = false;
        if let Some(old) = existing {
            match self.r_decide(ends, src, meta, &target, old)? {
                Decision::Skip => {
                    self.r_skip(meta);
                    return Ok(());
                }
                Decision::Rename(other) => target = other,
                Decision::Overwrite => {
                    if old.dir {
                        self.error_msg(src, t!("al suo posto c'è una cartella con lo stesso nome", "a folder with the same name is in its place").into());
                        self.r_skip(meta);
                        return Ok(());
                    }
                    replace = true;
                }
            }
        }
        match self.r_file(ends, src, meta, &target, replace) {
            Ok(()) => {
                self.p.files_done += 1;
                if moving {
                    if let Err(e) = ends.src.remove(src, false) {
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

    fn r_skip(&mut self, meta: Meta) {
        self.p.skipped += 1;
        self.p.files_done += 1;
        self.p.bytes_done += meta.size;
    }

    fn r_skip_tree(&mut self, ends: &Ends, root: &Path) {
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for (n, m) in ends.src.list(&dir).unwrap_or_default() {
                if m.dir {
                    stack.push(dir.join(n));
                } else {
                    self.r_skip(m);
                }
            }
        }
    }

    fn r_dir(&mut self, ends: &Ends, src: &Path, meta: Meta, target: &Path, existing: Option<Meta>, moving: bool) -> Step<()> {
        let mut target = target.to_path_buf();
        match existing {
            Some(old) if old.dir => {} // merge into it
            Some(old) => match self.r_decide(ends, src, meta, &target, old)? {
                Decision::Skip => {
                    self.r_skip_tree(ends, src);
                    return Ok(());
                }
                Decision::Rename(other) => target = other,
                Decision::Overwrite => {
                    if let Err(e) = ends.dst.remove(&target, false) {
                        self.error(src, &e);
                        self.r_skip_tree(ends, src);
                        return Ok(());
                    }
                }
            },
            None => {}
        }
        let created = ends.dst.stat(&target).is_err();
        if created {
            if let Err(e) = ends.dst.mkdir(&target) {
                self.error(src, &e);
                self.r_skip_tree(ends, src);
                return Ok(());
            }
            self.made_dirs.push(target.clone());
        }
        let children = match ends.src.list(src) {
            Ok(c) => c,
            Err(e) => {
                self.error(src, &e);
                return Ok(());
            }
        };
        for (name, m) in children {
            self.r_item(ends, &src.join(&name), Some(m), &target, &name, moving, false)?;
        }
        if created {
            ends.dst.set_mtime(&target, meta.mtime);
        }
        if moving {
            // a skipped or failed child keeps the source folder: that is right
            let _ = ends.src.remove(src, true);
        }
        Ok(())
    }

    fn r_decide(&mut self, ends: &Ends, src: &Path, meta: Meta, target: &Path, old: Meta) -> Step<Decision> {
        let dir = target.parent().unwrap_or(Path::new("/")).to_path_buf();
        let name = target.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        let policy = match self.apply_all.unwrap_or(self.spec.conflict) {
            Policy::Ask => {
                self.conflicts += 1;
                let info = ConflictInfo {
                    id: self.conflicts,
                    name: name.clone(),
                    path: self.display(src),
                    source: meta.side(),
                    target: old.side(),
                    rename_to: ends.dst.unique(&dir, &name, "").file_name().unwrap_or_default().to_string_lossy().into_owned(),
                };
                self.ask_info(info)?
            }
            p => p,
        };
        Ok(match policy {
            Policy::Skip => Decision::Skip,
            Policy::Overwrite => Decision::Overwrite,
            Policy::Rename | Policy::Ask => Decision::Rename(ends.dst.unique(&dir, &name, "")),
            Policy::Newer => {
                if meta.mtime > old.mtime {
                    Decision::Overwrite
                } else {
                    Decision::Skip
                }
            }
        })
    }

    /// Through a hidden temporary name beside the target, renamed into
    /// place when complete.
    fn r_file(&mut self, ends: &Ends, src: &Path, meta: Meta, target: &Path, replace: bool) -> io::Result<()> {
        let dir = target.parent().unwrap_or(Path::new("/"));
        let part = dir.join(part_name(target.file_name().unwrap_or_default()));
        let mut input = ends.src.reader(src)?;
        let _ = ends.dst.remove(&part, false);
        let mut output = ends.dst.writer(&part)?;
        let result = self.r_fill(&mut input, &mut output);
        drop(input);
        let result = result.and_then(|hash| {
            output.finish()?;
            if let Some(hash) = hash {
                self.r_verify(ends, &part, meta.size, hash)?;
            }
            ends.dst.set_mtime(&part, meta.mtime);
            if replace {
                ends.dst.remove(target, false)?;
            }
            ends.dst.rename(&part, target)
        });
        if result.is_err() {
            let _ = ends.dst.remove(&part, false);
        }
        result
    }

    /// Streams the bytes; with verification on, returns their hash.
    fn r_fill(&mut self, input: &mut Box<dyn Read>, output: &mut Box<dyn remote::Writer>) -> io::Result<Option<u128>> {
        if self.buf.len() != CHUNK {
            self.buf = vec![0; CHUNK];
        }
        let mut hash = self.spec.verify.then(xxhash_rust::xxh3::Xxh3::new);
        loop {
            let n = input.read(&mut self.buf)?;
            if n == 0 {
                return Ok(hash.map(|h| h.digest128()));
            }
            if let Some(h) = hash.as_mut() {
                h.update(&self.buf[..n]);
            }
            output.write_all(&self.buf[..n])?;
            self.advance(n as u64);
            if self.checkpoint().is_err() {
                return Err(io::Error::from(io::ErrorKind::Interrupted));
            }
        }
    }

    /// Reads the copy back from where it landed and compares.
    fn r_verify(&mut self, ends: &Ends, part: &Path, size: u64, want: u128) -> io::Result<()> {
        let phase = std::mem::replace(&mut self.p.phase, "verify".into());
        self.p.current_done = 0;
        self.p.current_size = size;
        let mut back = ends.dst.reader(part)?;
        let mut check = xxhash_rust::xxh3::Xxh3::new();
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
        if check.digest128() != want {
            return Err(io::Error::other(t!("verifica fallita: la copia è diversa dall'originale", "verification failed: the copy differs from the original")));
        }
        Ok(())
    }

    fn r_delete(&mut self) -> Step<()> {
        let sources = self.spec.sources.clone();
        let Some(end) = self.connect(&sources[0]) else { return Ok(()) };
        self.p.phase = "delete".into();
        self.p.method = "delete".into();
        self.p.scanning = true;
        // (path, is a folder, its items already removed)
        let mut todo: Vec<(PathBuf, bool, bool)> = Vec::new();
        let mut total = 0u64;
        let mut stack: Vec<(PathBuf, Option<Meta>)> = sources.iter().map(|s| (s.clone(), None)).collect();
        // count first, so the bar means something; deepest last
        while let Some((path, meta)) = stack.pop() {
            total += 1;
            if total % 64 == 0 {
                self.p.files_total = total;
                self.checkpoint()?;
            }
            let Some(meta) = meta.or_else(|| end.stat(&path).ok()) else { continue };
            todo.push((path.clone(), meta.dir, false));
            if meta.dir {
                match end.list(&path) {
                    Ok(items) => stack.extend(items.into_iter().map(|(n, m)| (path.join(n), Some(m)))),
                    Err(e) => self.error(&path, &e),
                }
            }
        }
        self.p.scanning = false;
        self.p.files_total = todo.len() as u64;
        // children come after their folder: remove from the end
        while let Some((path, dir, _)) = todo.pop() {
            self.checkpoint()?;
            self.p.current = self.display(&path);
            if let Err(e) = end.remove(&path, dir) {
                if !(dir && e.raw_os_error() == Some(libc::ENOTEMPTY)) {
                    self.error(&path, &e);
                }
            }
            self.p.files_done += 1;
        }
        Ok(())
    }
}
