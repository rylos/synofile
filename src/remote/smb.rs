//! SMB 2/3 servers (Windows, Samba, other NAS), with the smb crate.

use std::collections::HashSet;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::str::FromStr;
use std::sync::Mutex;
use std::time::Duration;

use smb::{
    Client, ClientConfig, CreateOptions, FileAccessMask, FileAttributes, FileBasicInformation, FileCreateArgs, FileDirectoryInformation,
    FileDispositionInformation, FileFsFullSizeInformation, FileRenameInformation, IoctlBuffer, PipeTransceiveRequest, Resource,
    UncPath,
};

use smb::binrw_util::prelude::FileTime;
use smb::resource::GetLen;

use super::{Conn, Entry, Fs, Reader, Writer, errno, srvsvc};

/// Largest single read or write: servers offer 1–8 MiB.
const BLOCK: usize = 1024 * 1024;
/// blocks read at once
const AHEAD: usize = 8;
/// 1601-01-01 to 1970-01-01, in seconds
const EPOCH_DIFF: u64 = 11_644_473_600;

pub struct Smb {
    client: Client,
    server: String,
    user: String,
    password: String,
    /// shares already connected, and the IPC$ of the share list
    trees: Mutex<HashSet<String>>,
}

impl Smb {
    pub fn connect(conn: &Conn) -> io::Result<Self> {
        let mut config = ClientConfig::default();
        config.dfs = false;
        config.connection.timeout = Some(Duration::from_secs(20));
        if conn.port != 0 {
            config.connection.port = Some(conn.port);
        }
        let user = match (conn.domain.trim(), conn.user.trim()) {
            (_, "") => "Guest".to_string(),
            ("", u) => u.to_string(),
            (d, u) if u.contains(['\\', '@']) => {
                let _ = d;
                u.to_string()
            }
            (d, u) => format!("{d}\\{u}"),
        };
        Ok(Self { client: Client::new(config), server: conn.host.trim().to_string(), user, password: conn.password.clone(), trees: Mutex::new(HashSet::new()) })
    }

    fn tree(&self, share: &str) -> io::Result<UncPath> {
        let unc = UncPath::from_str(&format!(r"\\{}\{}", self.server, share)).map_err(|_| errno(libc::EINVAL))?;
        let mut trees = self.trees.lock().unwrap();
        if !trees.contains(share) {
            self.client.share_connect(&unc, &self.user, self.password.clone()).map_err(map)?;
            trees.insert(share.to_string());
        }
        Ok(unc)
    }

    fn unc(&self, path: &[String]) -> io::Result<UncPath> {
        let share = path.first().ok_or_else(|| errno(libc::EISDIR))?;
        Ok(self.tree(share)?.with_path(&path[1..].join("\\")))
    }

    fn open(&self, path: &[String], args: &FileCreateArgs) -> io::Result<Resource> {
        let unc = self.unc(path)?;
        self.client.create_file(&unc, args).map_err(map)
    }

    fn shares(&self) -> io::Result<Vec<Entry>> {
        {
            let mut trees = self.trees.lock().unwrap();
            if !trees.contains("IPC$") {
                self.client.ipc_connect(&self.server, &self.user, self.password.clone()).map_err(map)?;
                trees.insert("IPC$".into());
            }
        }
        let pipe = self.client.open_pipe(&self.server, "srvsvc").map_err(map)?;
        let call = |data: Vec<u8>, max: u32| {
            pipe.handle().fsctl_with_options(PipeTransceiveRequest::from(IoctlBuffer::from(data)), max).map(|r| r.to_vec()).map_err(map)
        };
        call(srvsvc::bind(), 4096)?;
        let resp = call(srvsvc::share_enum(&self.server), 1 << 20)?;
        let _ = pipe.handle().close();
        let list = srvsvc::stub(&resp).and_then(|s| srvsvc::parse(&s)).map_err(io::Error::other)?;
        // disk shares only: no printers, no IPC$, no C$ and ADMIN$
        Ok(list
            .into_iter()
            .filter(|(_, kind, _)| *kind == 0)
            .map(|(name, _, _)| Entry { name, kind: 'd', size: 0, mtime: 0, mode: 0o755 })
            .collect())
    }
}

fn entry(name: String, attrs: &FileAttributes, size: u64, mtime: FileTime) -> Entry {
    let dir = attrs.directory();
    let mode = match (dir, attrs.readonly()) {
        (true, _) => 0o755,
        (false, true) => 0o444,
        (false, false) => 0o644,
    };
    Entry { name, kind: if dir { 'd' } else { 'f' }, size: if dir { 0 } else { size }, mtime: unix(mtime), mode }
}

fn unix(t: FileTime) -> i64 {
    (*t / 10_000_000).saturating_sub(EPOCH_DIFF) as i64
}

fn filetime(secs: i64) -> FileTime {
    FileTime::from((secs.max(0) as u64 + EPOCH_DIFF) * 10_000_000)
}

/// The server's status codes as the errno the messages know.
fn map(e: smb::Error) -> io::Error {
    let status = match &e {
        smb::Error::ReceivedErrorMessage(s, _) | smb::Error::UnexpectedMessageStatus(s) => *s,
        smb::Error::IoError(io) => return io::Error::new(io.kind(), io.to_string()),
        _ => return io::Error::other(e.to_string()),
    };
    let code = match status {
        0xC000_0034 | 0xC000_003A | 0xC000_00CC | 0xC000_0056 | 0xC000_000F => libc::ENOENT,
        0xC000_0022 | 0xC000_0061 => libc::EACCES,
        0xC000_006D | 0xC000_006E | 0xC000_0070 | 0xC000_0071 | 0xC000_0072 | 0xC000_0234 | 0xC000_0064 => {
            return io::Error::new(io::ErrorKind::PermissionDenied, t!("il server rifiuta l'accesso: utente o password errati", "the server refuses the login: wrong user name or password"));
        }
        0xC000_0035 => libc::EEXIST,
        0xC000_0101 => libc::ENOTEMPTY,
        0xC000_0043 | 0xC000_0054 => libc::EBUSY,
        0xC000_00BA => libc::EISDIR,
        0xC000_0103 => libc::ENOTDIR,
        0xC000_007F | 0xC000_0044 => libc::ENOSPC,
        0xC000_00A2 => libc::EROFS,
        0xC000_0033 => libc::EINVAL,
        0xC000_00D4 => libc::EXDEV,
        _ => return io::Error::other(e.to_string()),
    };
    errno(code)
}

fn close(r: Resource) {
    let _ = match &r {
        Resource::File(f) => f.close(),
        Resource::Directory(d) => d.close(),
        Resource::Pipe(p) => p.close(),
    };
}

impl Fs for Smb {
    fn list(&self, dir: &[String]) -> io::Result<Vec<Entry>> {
        if dir.is_empty() {
            return self.shares();
        }
        let r = self.open(dir, &FileCreateArgs::make_open_existing(FileAccessMask::new().with_generic_read(true)))?;
        let Resource::Directory(d) = r else {
            close(r);
            return Err(errno(libc::ENOTDIR));
        };
        let mut out = Vec::new();
        let items = d.query::<FileDirectoryInformation>("*").map_err(map)?;
        for item in items {
            let item = item.map_err(map)?;
            let name = item.file_name.to_string();
            if name == "." || name == ".." {
                continue;
            }
            out.push(entry(name, &item.file_attributes, item.end_of_file, item.last_write_time));
        }
        let _ = d.close();
        Ok(out)
    }

    fn stat(&self, path: &[String]) -> io::Result<Entry> {
        if path.len() <= 1 {
            if let Some(share) = path.first() {
                self.tree(share)?;
            }
            return Ok(Entry { name: path.first().cloned().unwrap_or_else(|| self.server.clone()), kind: 'd', size: 0, mtime: 0, mode: 0o755 });
        }
        // the parent's listing, for this one name: one round trip
        let (name, parent) = path.split_last().unwrap();
        let r = self.open(parent, &FileCreateArgs::make_open_existing(FileAccessMask::new().with_generic_read(true)))?;
        let Resource::Directory(d) = r else {
            close(r);
            return Err(errno(libc::ENOTDIR));
        };
        let found = d.query::<FileDirectoryInformation>(name).map_err(map).and_then(|mut it| match it.next() {
            Some(item) => item.map_err(map),
            None => Err(errno(libc::ENOENT)),
        });
        let _ = d.close();
        let item = match found {
            Err(e) if e.raw_os_error() == Some(libc::ENOENT) || e.kind() == io::ErrorKind::Other => return Err(errno(libc::ENOENT)),
            other => other?,
        };
        Ok(entry(item.file_name.to_string(), &item.file_attributes, item.end_of_file, item.last_write_time))
    }

    fn reader(&self, path: &[String]) -> io::Result<Box<dyn Reader>> {
        let r = self.open(path, &FileCreateArgs::make_open_existing(FileAccessMask::new().with_generic_read(true)))?;
        match r {
            Resource::File(file) => {
                let len = file.get_len().map_err(map)?;
                Ok(Box::new(SmbFile::new(file, len, 0)))
            }
            other => {
                close(other);
                Err(errno(libc::EISDIR))
            }
        }
    }

    fn writer(&self, path: &[String], at: Option<u64>) -> io::Result<Box<dyn Writer>> {
        let args = match at {
            None => FileCreateArgs::make_overwrite(FileAttributes::new(), CreateOptions::new().with_non_directory_file(true)),
            Some(_) => FileCreateArgs::make_open_existing(FileAccessMask::new().with_generic_read(true).with_generic_write(true)),
        };
        match self.open(path, &args)? {
            Resource::File(file) => Ok(Box::new(SmbFile::new(file, 0, at.unwrap_or(0)))),
            other => {
                close(other);
                Err(errno(libc::EISDIR))
            }
        }
    }

    fn mkdir(&self, path: &[String]) -> io::Result<()> {
        if path.len() < 2 {
            return Err(errno(libc::EACCES));
        }
        let r = self.open(path, &FileCreateArgs::make_create_new(FileAttributes::new().with_directory(true), CreateOptions::new().with_directory_file(true)))?;
        close(r);
        Ok(())
    }

    fn rename(&self, from: &[String], to: &[String]) -> io::Result<()> {
        if from.len() < 2 || to.len() < 2 {
            return Err(errno(libc::EACCES));
        }
        if from[0] != to[0] {
            return Err(errno(libc::EXDEV));
        }
        let r = self.open(from, &FileCreateArgs::make_open_existing(FileAccessMask::new().with_delete(true).with_file_read_attributes(true)))?;
        let info = FileRenameInformation { replace_if_exists: false.into(), root_directory: 0, file_name: to[1..].join("\\").as_str().into() };
        let result = match &r {
            Resource::File(f) => f.set_info(info),
            Resource::Directory(d) => d.set_info(info),
            Resource::Pipe(_) => Ok(()),
        };
        close(r);
        result.map_err(map)
    }

    fn remove(&self, path: &[String], dir: bool) -> io::Result<()> {
        if path.len() < 2 {
            return Err(errno(libc::EACCES));
        }
        let options = if dir { CreateOptions::new().with_directory_file(true) } else { CreateOptions::new().with_non_directory_file(true) };
        let args = FileCreateArgs { options, ..FileCreateArgs::make_open_existing(FileAccessMask::new().with_delete(true).with_file_read_attributes(true)) };
        let r = self.open(path, &args)?;
        let result = match &r {
            Resource::File(f) => f.set_info(FileDispositionInformation::default()),
            Resource::Directory(d) => d.set_info(FileDispositionInformation::default()),
            Resource::Pipe(_) => Ok(()),
        };
        close(r);
        result.map_err(map)
    }

    fn space(&self, path: &[String]) -> Option<(u64, u64)> {
        let share = path.first()?;
        let r = self.open(&[share.clone()], &FileCreateArgs::make_open_existing(FileAccessMask::new().with_file_read_attributes(true))).ok()?;
        let info = match &r {
            Resource::Directory(d) => d.query_fs_info::<FileFsFullSizeInformation>().ok(),
            _ => None,
        };
        close(r);
        let i = info?;
        let unit = i.sectors_per_allocation_unit as u64 * i.bytes_per_sector as u64;
        Some((i.caller_available_allocation_units * unit, i.total_allocation_units * unit))
    }

    fn set_mtime(&self, path: &[String], mtime: i64) {
        let Ok(r) = self.open(path, &FileCreateArgs::make_open_existing(FileAccessMask::new().with_file_write_attributes(true))) else { return };
        // zero leaves a time as it is
        let info = FileBasicInformation {
            creation_time: FileTime::ZERO,
            last_access_time: FileTime::ZERO,
            last_write_time: filetime(mtime),
            change_time: FileTime::ZERO,
            file_attributes: FileAttributes::new(),
        };
        let _ = match &r {
            Resource::File(f) => f.set_info(info),
            Resource::Directory(d) => d.set_info(info),
            Resource::Pipe(_) => Ok(()),
        };
        close(r);
    }

    fn is_top(&self, path: &[String]) -> bool {
        path.is_empty()
    }
}

/// An open file, read or written in blocks the server takes. The position
/// is kept here: the crate's own Seek does not move it.
struct SmbFile {
    file: Option<smb::File>,
    len: u64,
    pos: u64,
    /// read ahead: the bytes from `ahead_at` on, already fetched
    ahead: Vec<u8>,
    ahead_at: u64,
}

impl SmbFile {
    fn new(file: smb::File, len: u64, pos: u64) -> Self {
        Self { file: Some(file), len, pos, ahead: Vec::new(), ahead_at: 0 }
    }

    fn file(&self) -> io::Result<&smb::File> {
        self.file.as_ref().ok_or_else(|| errno(libc::EBADF))
    }

    /// The next blocks from the position, several requests in flight at
    /// once: one at a time a request's round trip caps the speed.
    fn fetch(&mut self) -> io::Result<()> {
        let file = self.file()?;
        let left = self.len - self.pos;
        let blocks = (left.div_ceil(BLOCK as u64) as usize).clamp(1, AHEAD);
        let start = self.pos;
        let parts: Vec<io::Result<Vec<u8>>> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..blocks)
                .map(|i| {
                    let at = start + (i * BLOCK) as u64;
                    let want = (BLOCK as u64).min(self.len.saturating_sub(at)) as usize;
                    s.spawn(move || {
                        let mut b = vec![0u8; want];
                        let mut got = 0;
                        while got < want {
                            let n = file.read_block(&mut b[got..], at + got as u64, None, false)?;
                            if n == 0 {
                                break;
                            }
                            got += n;
                        }
                        b.truncate(got);
                        Ok(b)
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err(io::Error::other("read thread")))).collect()
        });
        self.ahead.clear();
        self.ahead_at = start;
        for part in parts {
            let part = part?;
            let short = part.len() < BLOCK;
            self.ahead.extend_from_slice(&part);
            if short {
                break;
            }
        }
        if self.ahead.is_empty() {
            // the file shrank under us
            self.len = self.pos;
        }
        Ok(())
    }
}

impl Read for SmbFile {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.len {
            return Ok(0);
        }
        let have = self.pos >= self.ahead_at && self.pos < self.ahead_at + self.ahead.len() as u64;
        if !have {
            self.fetch()?;
        }
        let from = (self.pos - self.ahead_at) as usize;
        let n = buf.len().min(self.ahead.len() - from);
        buf[..n].copy_from_slice(&self.ahead[from..from + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for SmbFile {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let to = match pos {
            SeekFrom::Start(n) => n as i64,
            SeekFrom::End(n) => self.len as i64 + n,
            SeekFrom::Current(n) => self.pos as i64 + n,
        };
        if to < 0 {
            return Err(errno(libc::EINVAL));
        }
        self.pos = to as u64;
        Ok(self.pos)
    }
}

impl Write for SmbFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = buf.len().min(BLOCK);
        let done = self.file()?.write_block(&buf[..n], self.pos, None)?;
        self.pos += done as u64;
        Ok(done)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Reader for SmbFile {
    fn len(&self) -> u64 {
        self.len
    }
}

impl Writer for SmbFile {
    fn finish(mut self: Box<Self>) -> io::Result<()> {
        let file = self.file.take().ok_or_else(|| errno(libc::EBADF))?;
        let flushed = file.flush();
        let closed = file.close().map_err(map);
        flushed?;
        closed
    }
}

impl Drop for SmbFile {
    fn drop(&mut self) {
        if let Some(f) = self.file.take() {
            let _ = f.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_times() {
        assert_eq!(unix(filetime(1_700_000_000)), 1_700_000_000);
        assert_eq!(unix(FileTime::ZERO), 0);
    }
}
