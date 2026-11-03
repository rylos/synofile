//! Remote connections: SMB and SFTP servers, browsed and copied to and from
//! like the shared folders.
//!
//! A connection lives in the interface as the path `/:<id>/…`: a colon can
//! be in no shared folder's name. For SMB the first part below it is the
//! server's share (`/:<id>` alone lists the shares), for SFTP the path on
//! the server.
//!
//! The connections are kept for each DSM user in the package's own
//! directory, mode 0600, with the passwords sealed by AES-256-GCM under a
//! key of the package: a copy of the file alone (a backup) reveals nothing,
//! root on the NAS can read both. The CGI reads them as the package before
//! it becomes the user; a job gets the connections it needs in its spec.

pub mod api;
pub mod sftp;
pub mod smb;
mod srvsvc;

use std::io::{self, Read, Seek, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::cgi::ApiError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    #[default]
    Smb,
    Sftp,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Conn {
    pub id: String,
    /// the name in the sidebar, the user's to choose
    pub name: String,
    pub kind: Kind,
    pub host: String,
    /// 0 for the protocol's own
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub domain: String,
    #[serde(default)]
    pub user: String,
    /// SFTP: "password", "key" (the user's SynoFile key) or "own" (a key of
    /// the user's, imported into this connection)
    #[serde(default)]
    pub auth: String,
    /// where it opens: "share/folder" for SMB ("" lists the shares), a path
    /// on the server for SFTP ("" for the home)
    #[serde(default)]
    pub path: String,
    /// SFTP: the server's key, remembered on the first connection
    #[serde(default)]
    pub host_key: String,
    /// SFTP, "own": the imported key's type, fingerprint and comment
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub key_info: String,
    /// in memory only; sealed on disk
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub password: String,
    /// in memory only: the private key, for a job; an imported one is sealed
    /// on disk
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub ssh_key: String,
}

/// What the interface sees of a connection: no secrets.
#[derive(Serialize)]
pub struct Public<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub kind: Kind,
    pub host: &'a str,
    pub port: u16,
    pub domain: &'a str,
    pub user: &'a str,
    pub auth: &'a str,
    pub path: &'a str,
    pub has_password: bool,
    pub host_key: &'a str,
    pub key_info: &'a str,
}

impl Conn {
    pub fn public(&self) -> Public<'_> {
        Public {
            id: &self.id,
            name: &self.name,
            kind: self.kind,
            host: &self.host,
            port: self.port,
            domain: &self.domain,
            user: &self.user,
            auth: &self.auth,
            path: &self.path,
            has_password: !self.password.is_empty(),
            host_key: &self.host_key,
            key_info: &self.key_info,
        }
    }

    pub fn connect(&self) -> io::Result<Box<dyn Fs>> {
        Ok(match self.kind {
            Kind::Smb => Box::new(smb::Smb::connect(self)?),
            Kind::Sftp => Box::new(sftp::Sftp::connect(self)?),
        })
    }
}

/// An item on a server, the way fsops lists the local ones.
#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub name: String,
    /// d directory, f file, l symlink
    pub kind: char,
    pub size: u64,
    pub mtime: i64,
    pub mode: u32,
}

impl Entry {
    pub fn is_dir(&self) -> bool {
        self.kind == 'd'
    }
}

pub trait Reader: Read + Seek + Send {
    fn len(&self) -> u64;
}

pub trait Writer: Write + Send {
    /// Flushes and closes; an error here means the data may not be there.
    fn finish(self: Box<Self>) -> io::Result<()>;
}

/// A server, as the API and the worker use it. Paths are the parts below
/// the connection: for SMB the share first.
pub trait Fs: Send {
    fn list(&self, dir: &[String]) -> io::Result<Vec<Entry>>;
    fn stat(&self, path: &[String]) -> io::Result<Entry>;
    fn reader(&self, path: &[String]) -> io::Result<Box<dyn Reader>>;
    /// `None`: a new file, replacing any; `Some(n)`: an existing file,
    /// written from byte n on (an upload that resumes).
    fn writer(&self, path: &[String], at: Option<u64>) -> io::Result<Box<dyn Writer>>;
    fn mkdir(&self, path: &[String]) -> io::Result<()>;
    /// Never replaces: fails when `to` exists.
    fn rename(&self, from: &[String], to: &[String]) -> io::Result<()>;
    fn remove(&self, path: &[String], dir: bool) -> io::Result<()>;
    /// free and total bytes where `path` is
    fn space(&self, path: &[String]) -> Option<(u64, u64)>;
    fn set_mtime(&self, path: &[String], mtime: i64);
    /// whether a path names the server itself (SMB: the list of shares)
    fn is_top(&self, path: &[String]) -> bool {
        let _ = path;
        false
    }
}

/// A remote path: `/:<id>/a/b` → ("id", ["a", "b"]).
pub fn split(vpath: &str) -> Option<Result<(String, Vec<String>), ApiError>> {
    let rest = vpath.trim_start_matches('/').strip_prefix(':')?;
    let mut parts = rest.split('/').filter(|p| !p.is_empty());
    let id = parts.next().unwrap_or_default().to_string();
    let mut out = Vec::new();
    for p in parts {
        if p == "." || p == ".." || p.contains(['\0', '\\']) {
            return Some(Err(ApiError::bad_request("invalid path")));
        }
        out.push(p.to_string());
    }
    if id.is_empty() {
        return Some(Err(ApiError::bad_request("invalid path")));
    }
    Some(Ok((id, out)))
}

/// The same split for a job's paths.
pub fn split_path(path: &Path) -> Option<(String, Vec<String>)> {
    split(path.to_str()?)?.ok()
}

pub fn join(id: &str, parts: &[String]) -> PathBuf {
    let mut s = format!("/:{id}");
    for p in parts {
        s.push('/');
        s.push_str(p);
    }
    PathBuf::from(s)
}

pub fn is_remote(path: &Path) -> bool {
    path.as_os_str().as_encoded_bytes().starts_with(b"/:")
}

/// A name valid on Windows servers too.
pub fn valid_name(name: &str) -> Result<(), ApiError> {
    crate::shares::valid_name(name)?;
    if name.contains(['\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err(ApiError::bad_request(t!("il nome non può contenere \\ : * ? \" < > |", "the name cannot contain \\ : * ? \" < > |")));
    }
    Ok(())
}

// ---- the store ----

fn dir() -> PathBuf {
    crate::var_dir().join("remote")
}

fn user_file(user: &str) -> PathBuf {
    dir().join(format!("{}.json", user.to_lowercase().replace(['/', '.'], "_")))
}

#[derive(Serialize, Deserialize)]
struct Stored {
    #[serde(flatten)]
    conn: Conn,
    /// the password, sealed: hex of nonce and ciphertext
    #[serde(default, skip_serializing_if = "String::is_empty")]
    secret: String,
    /// an imported private key, sealed the same way
    #[serde(default, skip_serializing_if = "String::is_empty")]
    key_secret: String,
}

pub fn load(user: &str) -> Vec<Conn> {
    let Ok(bytes) = std::fs::read(user_file(user)) else { return Vec::new() };
    let stored: Vec<Stored> = serde_json::from_slice(&bytes).unwrap_or_default();
    let key = key().ok();
    stored
        .into_iter()
        .map(|s| {
            let mut c = s.conn;
            c.password = key.as_ref().and_then(|k| open(k, &s.secret)).unwrap_or_default();
            if c.auth == "own" {
                c.ssh_key = key.as_ref().and_then(|k| open(k, &s.key_secret)).unwrap_or_default();
            }
            c
        })
        .collect()
}

pub fn store(user: &str, conns: &[Conn]) -> io::Result<()> {
    let key = key()?;
    let stored: Vec<Stored> = conns
        .iter()
        .map(|c| {
            let secret = if c.password.is_empty() { String::new() } else { seal(&key, &c.password) };
            let key_secret = if c.auth == "own" && !c.ssh_key.is_empty() { seal(&key, &c.ssh_key) } else { String::new() };
            Stored { conn: Conn { password: String::new(), ssh_key: String::new(), ..c.clone() }, secret, key_secret }
        })
        .collect();
    write_private(&user_file(user), &serde_json::to_vec_pretty(&stored).map_err(io::Error::other)?)
}

/// The connection with the user's own SynoFile key, when it logs in with it.
pub fn with_user_key(user: &str, mut c: Conn) -> Conn {
    if c.kind == Kind::Sftp && c.auth == "key" && c.ssh_key.is_empty() {
        c.ssh_key = ssh_key(user, false).ok().flatten().map(|(private, _)| private).unwrap_or_default();
    }
    c
}

/// The connections a job names, as the user keeps them now, secrets
/// included: a job back from the journal on disk has none. A connection
/// deleted since stays as it was, without secrets, and fails to log in.
pub fn with_secrets(user: &str, conns: &[Conn]) -> Vec<Conn> {
    let saved = load(user);
    conns.iter().map(|c| with_user_key(user, saved.iter().find(|s| s.id == c.id).cloned().unwrap_or_else(|| c.clone()))).collect()
}

/// Whether this process may pin a server's key: only the package's own,
/// which keep the connections. A process running as the user (browsing,
/// a job) cannot save what it learns, so it accepts no unknown key.
pub fn may_pin() -> bool {
    use std::os::unix::fs::MetadataExt;
    let d = dir();
    let probe = if d.exists() { d } else { crate::var_dir() };
    // SAFETY: geteuid has no preconditions
    std::fs::metadata(probe).is_ok_and(|m| m.uid() == unsafe { libc::geteuid() })
}

/// How long the first look at an SFTP server's key may take: the CGI waits
/// on it, and the daemon answers the CGI within 15 seconds.
const PIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Pins the key of an SFTP server none is known for yet (the server was
/// out of reach when the connection was saved): learnt now, without
/// logging in, and saved with the user's connections, so from then on
/// only that key is accepted. Package processes only (`may_pin`).
pub fn pin_host_key(user: &str, conn: &mut Conn) -> io::Result<()> {
    if conn.kind != Kind::Sftp || !conn.host_key.is_empty() {
        return Ok(());
    }
    if !may_pin() {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    let key = sftp::server_key(conn, PIN_TIMEOUT)?;
    let mut saved = load(user);
    if let Some(s) = saved.iter_mut().find(|s| s.id == conn.id) {
        if !s.host_key.is_empty() {
            // pinned by someone else meanwhile: that one counts
            conn.host_key = s.host_key.clone();
            return Ok(());
        }
        if s.kind == conn.kind && s.host.eq_ignore_ascii_case(&conn.host) && s.port == conn.port {
            s.host_key = key.clone();
            store(user, &saved)?;
        }
    }
    conn.host_key = key;
    Ok(())
}

/// Writes `data` to `path` all at once (temporary file, then rename),
/// readable by the package only.
fn write_private(path: &Path, data: &[u8]) -> io::Result<()> {
    let tmp = write_temp(path, data)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// `data` in a new file beside `path`, mode 0600, named after this process
/// so two writers never share it.
fn write_temp(path: &Path, data: &[u8]) -> io::Result<PathBuf> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::create_dir_all(path.parent().unwrap_or(Path::new("/")))?;
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.tmp", std::process::id()));
    let tmp = path.with_file_name(name);
    let _ = std::fs::remove_file(&tmp);
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW)
        .mode(0o600)
        .open(&tmp)
        .and_then(|mut f| f.write_all(data).and_then(|()| f.sync_all()));
    match written {
        Ok(()) => Ok(tmp),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

pub fn random_bytes<const N: usize>() -> io::Result<[u8; N]> {
    let mut b = [0u8; N];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut b)?;
    Ok(b)
}

pub fn new_id() -> String {
    hex(&random_bytes::<6>().unwrap_or_default())
}

/// The key that seals the secrets, made on first use. Two processes
/// starting at once agree on one key (a lock, and a rename that never
/// replaces); a key file of the wrong size is an error, never replaced:
/// that would lose every password sealed with it.
fn key() -> io::Result<[u8; 32]> {
    key_at(&dir().join("key"))
}

fn key_at(path: &Path) -> io::Result<[u8; 32]> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::fd::AsRawFd;
    let read = |path: &Path| -> io::Result<Option<[u8; 32]>> {
        match std::fs::read(path) {
            Ok(b) => b.try_into().map(Some).map_err(|_| io::Error::other(t!("la chiave delle connessioni è danneggiata", "the connections' key is damaged"))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    };
    if let Some(k) = read(path)? {
        return Ok(k);
    }
    let dir = path.parent().unwrap_or(Path::new("/"));
    std::fs::create_dir_all(dir)?;
    let mut lock_name = path.file_name().unwrap_or_default().to_os_string();
    lock_name.push(".lock");
    let lock = std::fs::OpenOptions::new().write(true).create(true).custom_flags(libc::O_NOFOLLOW).mode(0o600).open(dir.join(lock_name))?;
    // SAFETY: flock on a descriptor we own; released when `lock` closes
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // made by another process while this one waited
    if let Some(k) = read(path)? {
        return Ok(k);
    }
    let k = random_bytes::<32>()?;
    let tmp = write_temp(path, &k)?;
    let placed = crate::fsops::rename_noreplace(&tmp, path);
    let _ = std::fs::remove_file(&tmp);
    match placed {
        Ok(()) => Ok(k),
        // one made without the lock after all: that one is the key
        Err(e) if e.raw_os_error() == Some(libc::EEXIST) => read(path)?.ok_or(e),
        Err(e) => Err(e),
    }
}

fn seal(key: &[u8; 32], text: &str) -> String {
    use aes_gcm::aead::{Aead, KeyInit};
    let cipher = aes_gcm::Aes256Gcm::new(key.into());
    let nonce = random_bytes::<12>().unwrap_or_default();
    match cipher.encrypt((&nonce).into(), text.as_bytes()) {
        Ok(ct) => hex(&[&nonce[..], &ct].concat()),
        Err(_) => String::new(),
    }
}

fn open(key: &[u8; 32], secret: &str) -> Option<String> {
    use aes_gcm::aead::{Aead, KeyInit};
    let raw = unhex(secret)?;
    if raw.len() < 12 {
        return None;
    }
    let cipher = aes_gcm::Aes256Gcm::new(key.into());
    let pt = cipher.decrypt(raw[..12].into(), &raw[12..]).ok()?;
    String::from_utf8(pt).ok()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

/// The user's own SSH key for SFTP servers, made on first use: the private
/// half in the package's directory, the public one for authorized_keys.
pub fn ssh_key(user: &str, create: bool) -> io::Result<Option<(String, String)>> {
    let path = dir().join(format!("{}.ssh", user.to_lowercase().replace(['/', '.'], "_")));
    let private = match std::fs::read_to_string(&path) {
        Ok(p) => p,
        Err(_) if create => {
            let p = sftp::new_key()?;
            write_private(&path, p.as_bytes())?;
            p
        }
        Err(_) => return Ok(None),
    };
    let public = sftp::public_key(&private, &format!("synofile-{user}"))?;
    Ok(Some((private, public)))
}

/// errno for the messages fsops::describe already has.
pub fn errno(code: i32) -> io::Error {
    io::Error::from_raw_os_error(code)
}

/// Development only: `synofile remote <op> <path> [arg]` against the
/// connection in $SYNOFILE_CONN (JSON), to try a server by hand.
#[cfg(debug_assertions)]
pub fn probe(args: &[&str]) -> std::process::ExitCode {
    let run = || -> io::Result<()> {
        let conn: Conn = serde_json::from_str(&std::env::var("SYNOFILE_CONN").map_err(other_err)?).map_err(other_err)?;
        let t = std::time::Instant::now();
        let fs = conn.connect()?;
        eprintln!("connected in {:?}", t.elapsed());
        let parts = |p: &str| p.split('/').filter(|x| !x.is_empty()).map(String::from).collect::<Vec<_>>();
        let p = parts(args.get(1).copied().unwrap_or(""));
        match args.first().copied().unwrap_or("ls") {
            "ls" => {
                for e in fs.list(&p)? {
                    println!("{} {:>12} {} {:o} {}", e.kind, e.size, e.mtime, e.mode, e.name);
                }
            }
            "stat" => println!("{:?}", fs.stat(&p)?),
            "get" => {
                let mut r = fs.reader(&p)?;
                let mut out = std::fs::File::create(args[2])?;
                let mut buf = vec![0u8; 1 << 20];
                let mut n = 0u64;
                loop {
                    let k = r.read(&mut buf)?;
                    if k == 0 {
                        break;
                    }
                    out.write_all(&buf[..k])?;
                    n += k as u64;
                }
                println!("{n} bytes of {} in {:?}", r.len(), t.elapsed());
            }
            "put" => {
                let mut w = fs.writer(&p, None)?;
                let mut input = std::fs::File::open(args[2])?;
                let mut buf = vec![0u8; 1 << 20];
                let mut n = 0u64;
                loop {
                    let k = input.read(&mut buf)?;
                    if k == 0 {
                        break;
                    }
                    w.write_all(&buf[..k])?;
                    n += k as u64;
                }
                w.finish()?;
                println!("{n} bytes in {:?}", t.elapsed());
            }
            "mkdir" => fs.mkdir(&p)?,
            "mv" => fs.rename(&p, &parts(args[2]))?,
            "rm" => fs.remove(&p, false)?,
            "rmdir" => fs.remove(&p, true)?,
            "df" => println!("{:?}", fs.space(&p)),
            "touch" => fs.set_mtime(&p, args[2].parse().unwrap_or(0)),
            _ => return Err(io::Error::other("ops: ls stat get put mkdir mv rm rmdir df touch")),
        }
        eprintln!("done in {:?}", t.elapsed());
        Ok(())
    };
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e} ({:?}, os {:?}) → {}", e.kind(), e.raw_os_error(), crate::fsops::describe(&e));
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(debug_assertions)]
fn other_err(e: impl std::fmt::Display) -> io::Error {
    io::Error::other(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_paths() {
        let (id, parts) = split("/:ab12/Share/a b").unwrap().unwrap();
        assert_eq!(id, "ab12");
        assert_eq!(parts, vec!["Share", "a b"]);
        assert!(split("/Share/x").is_none());
        assert!(split("/:ab12/../x").unwrap().is_err());
        assert_eq!(join("ab12", &parts), PathBuf::from("/:ab12/Share/a b"));
        assert!(is_remote(Path::new("/:x/y")));
        assert!(!is_remote(Path::new("/volume1/x")));
    }

    #[test]
    fn seals_and_opens() {
        let key = [7u8; 32];
        let s = seal(&key, "pässword");
        assert_eq!(open(&key, &s).as_deref(), Some("pässword"));
        assert_eq!(open(&[8u8; 32], &s), None);
        assert_eq!(unhex(&hex(&[0, 255, 16])), Some(vec![0, 255, 16]));
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("synofile-key-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn one_key_for_concurrent_first_uses() {
        let dir = scratch("race");
        let path = dir.join("key");
        let keys: Vec<[u8; 32]> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..8).map(|_| s.spawn(|| key_at(&path).unwrap())).collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert!(keys.iter().all(|k| *k == keys[0]));
        assert_eq!(std::fs::read(&path).unwrap(), keys[0]);
        // read again, not made again
        assert_eq!(key_at(&path).unwrap(), keys[0]);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        // no temporary files left behind
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name()).filter(|n| n.to_string_lossy().ends_with(".tmp")).collect();
        assert!(left.is_empty(), "{left:?}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn damaged_key_is_an_error_not_replaced() {
        let dir = scratch("short");
        let path = dir.join("key");
        std::fs::write(&path, b"too short").unwrap();
        assert!(key_at(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"too short");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn private_writes_replace_whole_files() {
        let dir = scratch("write");
        let path = dir.join("u.json");
        write_private(&path, b"one").unwrap();
        write_private(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
