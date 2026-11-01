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

fn write_private(path: &Path, data: &[u8]) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::create_dir_all(dir())?;
    let tmp = path.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
    f.write_all(data)?;
    f.sync_all()?;
    std::fs::rename(tmp, path)
}

pub fn random_bytes<const N: usize>() -> io::Result<[u8; N]> {
    let mut b = [0u8; N];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut b)?;
    Ok(b)
}

pub fn new_id() -> String {
    hex(&random_bytes::<6>().unwrap_or_default())
}

fn key() -> io::Result<[u8; 32]> {
    let path = dir().join("key");
    if let Ok(b) = std::fs::read(&path) {
        if let Ok(k) = b.try_into() {
            return Ok(k);
        }
    }
    let k = random_bytes::<32>()?;
    write_private(&path, &k)?;
    Ok(k)
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
    if s.len() % 2 != 0 {
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
