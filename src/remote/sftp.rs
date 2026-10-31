//! SFTP servers, with russh. The library is async: each connection keeps
//! a small runtime of its own and every call waits on it, so the rest of
//! SynoFile stays plain threads.

use std::io::{self, Read, Seek, SeekFrom, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::ssh_key::{HashAlg, LineEnding, PublicKey};
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::runtime::Runtime;

use super::{Conn, Entry, Fs, Reader, Writer, errno};

const TIMEOUT: Duration = Duration::from_secs(20);

pub struct Sftp {
    rt: Arc<Runtime>,
    sftp: SftpSession,
    _session: russh::client::Handle<Check>,
    /// the server's key as seen on this connection
    pub host_key: String,
    /// where the user lands, absolute
    pub home: String,
}

/// Accepts the server's key when it is the one remembered, or when none
/// is (the first connection: the API remembers it).
pub struct Check {
    expected: String,
    seen: Arc<Mutex<String>>,
}

impl russh::client::Handler for Check {
    type Error = russh::Error;
    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        let seen = key.fingerprint(HashAlg::Sha256).to_string();
        let ok = self.expected.is_empty() || self.expected == seen;
        *self.seen.lock().unwrap() = seen;
        Ok(ok)
    }
}

fn other(e: impl std::fmt::Display) -> io::Error {
    io::Error::other(e.to_string())
}

fn map(e: russh_sftp::client::error::Error) -> io::Error {
    use russh_sftp::client::error::Error;
    match e {
        Error::Status(s) => match s.status_code {
            StatusCode::NoSuchFile => errno(libc::ENOENT),
            StatusCode::PermissionDenied => errno(libc::EACCES),
            StatusCode::Eof => io::Error::from(io::ErrorKind::UnexpectedEof),
            StatusCode::OpUnsupported => errno(libc::EOPNOTSUPP),
            _ if s.error_message.is_empty() => other(s.status_code),
            _ => other(s.error_message),
        },
        Error::Timeout => errno(libc::ETIMEDOUT),
        e => other(e),
    }
}

impl Sftp {
    pub fn connect(conn: &Conn) -> io::Result<Self> {
        let rt = Arc::new(tokio::runtime::Builder::new_current_thread().enable_all().build()?);
        let seen = Arc::new(Mutex::new(String::new()));
        let check = Check { expected: conn.host_key.clone(), seen: Arc::clone(&seen) };
        let port = if conn.port == 0 { 22 } else { conn.port };
        let host = conn.host.trim().to_string();
        let result = rt.block_on(async {
            let config = Arc::new(russh::client::Config { inactivity_timeout: Some(Duration::from_secs(600)), ..Default::default() });
            let mut session = match tokio::time::timeout(TIMEOUT, russh::client::connect(config, (host.as_str(), port), check)).await {
                Err(_) => return Err(errno(libc::ETIMEDOUT)),
                Ok(Err(russh::Error::UnknownKey)) => {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        t!("la chiave del server è cambiata dall'ultima connessione: se è giusto, spunta «dimentica» in Modifica connessione", "the server's key changed since the last connection: if that is right, tick “forget” in Edit connection"),
                    ));
                }
                Ok(Err(e)) => return Err(other(e)),
                Ok(Ok(s)) => s,
            };
            let auth = if conn.auth == "key" {
                let key = russh::keys::decode_secret_key(&conn.ssh_key, None).map_err(other)?;
                let hash = session.best_supported_rsa_hash().await.map_err(other)?.flatten();
                session.authenticate_publickey(&conn.user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await
            } else {
                session.authenticate_password(&conn.user, &conn.password).await
            };
            if !auth.map_err(other)?.success() {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, t!("il server rifiuta l'accesso: utente, password o chiave errati", "the server refuses the login: wrong user name, password or key")));
            }
            let channel = session.channel_open_session().await.map_err(other)?;
            channel.request_subsystem(true, "sftp").await.map_err(other)?;
            let sftp = SftpSession::new(channel.into_stream()).await.map_err(map)?;
            sftp.set_timeout(TIMEOUT.as_secs());
            let home = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".into());
            Ok((session, sftp, home))
        });
        let (session, sftp, home) = result?;
        let host_key = seen.lock().unwrap().clone();
        Ok(Self { rt, sftp, _session: session, host_key, home })
    }

    fn path(parts: &[String]) -> String {
        format!("/{}", parts.join("/"))
    }

    fn entry(name: String, a: &FileAttributes) -> Entry {
        let dir = a.is_dir();
        Entry {
            name,
            kind: if dir { 'd' } else if a.is_symlink() { 'l' } else { 'f' },
            size: if dir { 0 } else { a.size.unwrap_or(0) },
            mtime: a.mtime.unwrap_or(0) as i64,
            mode: a.permissions.unwrap_or(0o644) & 0o7777,
        }
    }

    fn exists(&self, path: &str) -> bool {
        self.rt.block_on(self.sftp.symlink_metadata(path)).is_ok()
    }
}

impl Fs for Sftp {
    fn list(&self, dir: &[String]) -> io::Result<Vec<Entry>> {
        let path = Self::path(dir);
        let items = self.rt.block_on(self.sftp.read_dir(path.clone())).map_err(map)?;
        let mut out = Vec::new();
        for item in items {
            let name = item.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let meta = item.metadata();
            let mut e = Self::entry(name.clone(), &meta);
            if e.kind == 'l' {
                // a link to a folder opens like one
                if let Ok(target) = self.rt.block_on(self.sftp.metadata(format!("{}/{}", path.trim_end_matches('/'), name))) {
                    e = Self::entry(name, &target);
                }
            }
            out.push(e);
        }
        Ok(out)
    }

    fn stat(&self, path: &[String]) -> io::Result<Entry> {
        let meta = self.rt.block_on(self.sftp.metadata(Self::path(path))).map_err(map)?;
        Ok(Self::entry(path.last().cloned().unwrap_or_else(|| "/".into()), &meta))
    }

    fn reader(&self, path: &[String]) -> io::Result<Box<dyn Reader>> {
        let p = Self::path(path);
        let meta = self.rt.block_on(self.sftp.metadata(p.clone())).map_err(map)?;
        if meta.is_dir() {
            return Err(errno(libc::EISDIR));
        }
        let len = meta.size.unwrap_or(0);
        let file = self.rt.block_on(self.sftp.open(p.clone())).map_err(map)?;
        let mut r = SftpFile::new(&self.rt, file, len);
        // more handles only for a file worth reading ahead
        if len > BLOCK as u64 {
            for _ in 1..AHEAD {
                match self.rt.block_on(self.sftp.open(p.clone())) {
                    Ok(f) => r.spare.push(f),
                    Err(_) => break,
                }
            }
        }
        Ok(Box::new(r))
    }

    fn writer(&self, path: &[String], at: Option<u64>) -> io::Result<Box<dyn Writer>> {
        let p = Self::path(path);
        let file = match at {
            None => self.rt.block_on(self.sftp.create(p)).map_err(map)?,
            Some(n) => {
                let mut f = self.rt.block_on(self.sftp.open_with_flags(p, OpenFlags::WRITE)).map_err(map)?;
                self.rt.block_on(f.seek(SeekFrom::Start(n)))?;
                f
            }
        };
        let mut w = SftpFile::new(&self.rt, file, 0);
        w.pos = at.unwrap_or(0);
        Ok(Box::new(w))
    }

    fn mkdir(&self, path: &[String]) -> io::Result<()> {
        let p = Self::path(path);
        if self.exists(&p) {
            return Err(errno(libc::EEXIST));
        }
        self.rt.block_on(self.sftp.create_dir(p)).map_err(map)
    }

    fn rename(&self, from: &[String], to: &[String]) -> io::Result<()> {
        let to = Self::path(to);
        if self.exists(&to) {
            return Err(errno(libc::EEXIST));
        }
        self.rt.block_on(self.sftp.rename(Self::path(from), to)).map_err(map)
    }

    fn remove(&self, path: &[String], dir: bool) -> io::Result<()> {
        let p = Self::path(path);
        if dir {
            self.rt.block_on(self.sftp.remove_dir(p)).map_err(|e| {
                let e = map(e);
                // OpenSSH answers a plain failure for a folder that is not empty
                if e.kind() == io::ErrorKind::Other { errno(libc::ENOTEMPTY) } else { e }
            })
        } else {
            self.rt.block_on(self.sftp.remove_file(p)).map_err(map)
        }
    }

    fn space(&self, path: &[String]) -> Option<(u64, u64)> {
        let s = self.rt.block_on(self.sftp.fs_info(Self::path(path))).ok()??;
        Some((s.blocks_avail * s.fragment_size, s.blocks * s.fragment_size))
    }

    fn set_mtime(&self, path: &[String], mtime: i64) {
        let mut attrs = FileAttributes::empty();
        attrs.mtime = Some(mtime.max(0) as u32);
        attrs.atime = Some(mtime.max(0) as u32);
        let _ = self.rt.block_on(self.sftp.set_metadata(Self::path(path), attrs));
    }
}

type RFile = russh_sftp::client::fs::File;

/// Read ahead: blocks of this size, as many in flight as handles.
const BLOCK: usize = 1024 * 1024;
const AHEAD: usize = 6;

struct SftpFile {
    rt: Arc<Runtime>,
    file: Option<RFile>,
    len: u64,
    /// reading: more handles on the same file, each fetching its block
    spare: Vec<RFile>,
    pos: u64,
    ahead: Vec<u8>,
    ahead_at: u64,
}

impl SftpFile {
    fn new(rt: &Arc<Runtime>, file: RFile, len: u64) -> Self {
        Self { rt: Arc::clone(rt), file: Some(file), len, spare: Vec::new(), pos: 0, ahead: Vec::new(), ahead_at: 0 }
    }

    fn file(&mut self) -> io::Result<&mut RFile> {
        self.file.as_mut().ok_or_else(|| errno(libc::EBADF))
    }

    /// The next blocks from the position, one handle each, all at once.
    fn fetch(&mut self) -> io::Result<()> {
        let mut handles = std::mem::take(&mut self.spare);
        handles.insert(0, self.file.take().ok_or_else(|| errno(libc::EBADF))?);
        let left = self.len - self.pos;
        let blocks = (left.div_ceil(BLOCK as u64) as usize).clamp(1, handles.len());
        let start = self.pos;
        let len = self.len;
        let results = self.rt.block_on(async {
            let mut tasks = Vec::new();
            for (i, mut f) in handles.into_iter().enumerate() {
                let at = start + (i * BLOCK) as u64;
                let want = if i < blocks { (BLOCK as u64).min(len.saturating_sub(at)) as usize } else { 0 };
                tasks.push(tokio::spawn(async move {
                    let mut b = vec![0u8; want];
                    let mut got = 0;
                    let r: io::Result<()> = async {
                        if want > 0 {
                            f.seek(SeekFrom::Start(at)).await?;
                            while got < want {
                                let n = f.read(&mut b[got..]).await?;
                                if n == 0 {
                                    break;
                                }
                                got += n;
                            }
                        }
                        Ok(())
                    }
                    .await;
                    b.truncate(got);
                    (f, r.map(|()| b))
                }));
            }
            let mut out = Vec::new();
            for t in tasks {
                out.push(t.await.map_err(other));
            }
            out
        });
        self.ahead.clear();
        self.ahead_at = start;
        let mut failed = None;
        let mut short = false;
        for r in results {
            match r {
                Ok((f, data)) => {
                    if self.file.is_none() {
                        self.file = Some(f);
                    } else {
                        self.spare.push(f);
                    }
                    match data {
                        Ok(d) if !short => {
                            short = d.len() < BLOCK;
                            self.ahead.extend_from_slice(&d);
                        }
                        Ok(_) => {}
                        Err(e) => failed = failed.or(Some(e)),
                    }
                }
                Err(e) => failed = failed.or(Some(e)),
            }
        }
        if let Some(e) = failed {
            return Err(e);
        }
        if self.ahead.is_empty() {
            self.len = self.pos;
        }
        Ok(())
    }
}

impl Read for SftpFile {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.len {
            return Ok(0);
        }
        let have = self.pos >= self.ahead_at && self.pos < self.ahead_at + self.ahead.len() as u64;
        if !have {
            self.fetch()?;
            if self.ahead.is_empty() {
                return Ok(0);
            }
        }
        let from = (self.pos - self.ahead_at) as usize;
        let n = buf.len().min(self.ahead.len() - from);
        buf[..n].copy_from_slice(&self.ahead[from..from + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for SftpFile {
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

impl Write for SftpFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let rt = Arc::clone(&self.rt);
        let f = self.file()?;
        rt.block_on(f.write(buf))
    }
    fn flush(&mut self) -> io::Result<()> {
        let rt = Arc::clone(&self.rt);
        let f = self.file()?;
        rt.block_on(f.flush())
    }
}

impl Reader for SftpFile {
    fn len(&self) -> u64 {
        self.len
    }
}

impl Writer for SftpFile {
    fn finish(mut self: Box<Self>) -> io::Result<()> {
        let rt = Arc::clone(&self.rt);
        let mut f = self.file.take().ok_or_else(|| errno(libc::EBADF))?;
        rt.block_on(async {
            f.flush().await?;
            f.shutdown().await
        })
    }
}

impl Drop for SftpFile {
    fn drop(&mut self) {
        for mut f in self.file.take().into_iter().chain(std::mem::take(&mut self.spare)) {
            let _ = self.rt.block_on(f.shutdown());
        }
    }
}

/// A new Ed25519 key, in OpenSSH's format.
pub fn new_key() -> io::Result<String> {
    let mut seed = super::random_bytes::<32>()?;
    let key = PrivateKey::from(russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&seed));
    seed.fill(0);
    Ok(key.to_openssh(LineEnding::LF).map_err(other)?.to_string())
}

/// The line for the server's authorized_keys.
pub fn public_key(private: &str, comment: &str) -> io::Result<String> {
    let key = russh::keys::decode_secret_key(private, None).map_err(other)?;
    let mut public = key.public_key().clone();
    public.set_comment(comment);
    public.to_openssh().map_err(other)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_keys() {
        let k = new_key().unwrap();
        assert!(k.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
        let p = public_key(&k, "synofile-marco").unwrap();
        assert!(p.starts_with("ssh-ed25519 ") && p.ends_with(" synofile-marco"));
    }
}
