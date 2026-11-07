//! Who is calling. DSM checks its own session cookie: authenticate.cgi prints
//! the user name of a valid session and nothing otherwise. It reads the
//! request from the environment, which a CGI child inherits as it is.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use crate::cgi::{ApiError, Request};

const AUTHENTICATE: &str = "/usr/syno/synoman/webman/modules/authenticate.cgi";
const ADMIN_GROUP: &str = "administrators";
/// How long a session DSM accepted is taken as good without asking again.
const CACHE_FOR: Duration = Duration::from_secs(20);

/// The DSM user behind the request, refused unless an administrator: the
/// package is reserved to them, whatever the folder permissions say. With
/// it, /etc/group as read for the check, for the user's other groups.
pub fn require_admin(req: &Request) -> Result<(String, String), ApiError> {
    // debug builds only, for the local development server
    #[cfg(debug_assertions)]
    if let Ok(user) = std::env::var("SYNOFILE_DEV_USER") {
        return Ok((user, String::new()));
    }
    let cookies = std::env::var("HTTP_COOKIE").unwrap_or_default();
    let session = cookie(&cookies, "id");
    let token = std::env::var("HTTP_X_SYNO_TOKEN").ok().filter(|t| !t.is_empty()).or_else(|| req.param("SynoToken").map(String::from));
    let cache = session.map(|id| {
        let addr = std::env::var("REMOTE_ADDR").unwrap_or_default();
        Cache::new(crate::var_dir().join("auth"), &cache_key(id, token.as_deref().unwrap_or_default(), &addr, cookie(&cookies, "did")))
    });
    let now = SystemTime::now();
    let user = match cache.as_ref().and_then(|c| c.get(now)) {
        Some(user) => user,
        None => {
            let user = authenticate()?;
            if user.is_empty() {
                let why = if session.is_some() { "rejected" } else { "nocookie" };
                return Err(ApiError::new(401, "not logged in to DSM").with_auth(why));
            }
            if let Some(c) = &cache {
                c.put(&user, now);
            }
            user
        }
    };
    // read on every request: a user taken out of the group loses access at once
    let groups = fs::read_to_string("/etc/group").unwrap_or_default();
    if !is_member(&groups, ADMIN_GROUP, &user) {
        return Err(ApiError::new(403, format!("{user} is not an administrator")));
    }
    Ok((user, groups))
}

/// Asks DSM whose session this request carries: empty for none.
fn authenticate() -> Result<String, ApiError> {
    let output = Command::new(AUTHENTICATE)
        .env_clear()
        .envs(std::env::vars_os().filter(|(name, _)| !is_unsafe_env(&name.to_string_lossy())))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| ApiError::new(500, format!("cannot run {AUTHENTICATE}: {e}")))?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// The value of one cookie of a `Cookie:` header.
fn cookie<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    header.split(';').filter_map(|pair| pair.trim().split_once('=')).find(|(k, _)| *k == name).map(|(_, v)| v).filter(|v| !v.is_empty())
}

/// What identifies a login to DSM: its session cookie, the token that goes
/// with it, the address it comes from. Hashed, so the cache holds no
/// session that could be replayed.
fn cache_key(session: &str, token: &str, addr: &str, device: Option<&str>) -> String {
    let mut h = Sha256::new();
    for part in [b"synofile-auth-1".as_slice(), session.as_bytes(), token.as_bytes(), addr.as_bytes(), device.unwrap_or_default().as_bytes()] {
        // lengths first: no two different sets of values hash the same text
        h.update((part.len() as u64).to_le_bytes());
        h.update(part);
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The logins DSM accepted in the last seconds, one file each in the
/// package's own directory: the CGI is a new process for every request.
/// Any failure only means asking DSM again.
struct Cache {
    dir: PathBuf,
    file: PathBuf,
}

impl Cache {
    fn new(dir: PathBuf, key: &str) -> Self {
        let file = dir.join(key);
        Self { dir, file }
    }

    fn get(&self, now: SystemTime) -> Option<String> {
        let text = fs::read_to_string(&self.file).ok()?;
        let (user, at) = text.trim_end().split_once('\n')?;
        fresh(at.parse().ok()?, now).then(|| user.to_string()).filter(|u| !u.is_empty())
    }

    fn put(&self, user: &str, now: SystemTime) {
        if user.contains('\n') || fs::DirBuilder::new().mode(0o700).recursive(true).create(&self.dir).is_err() {
            return;
        }
        let tmp = self.file.with_extension(format!("{}.tmp", std::process::id()));
        let written = (|| -> std::io::Result<()> {
            let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(&tmp)?;
            write!(f, "{user}\n{}\n", secs(now))?;
            fs::rename(&tmp, &self.file)
        })();
        if written.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        // now and then, the old entries go
        if now.duration_since(UNIX_EPOCH).is_ok_and(|d| d.subsec_nanos() % 16 == 0) {
            sweep(&self.dir, now);
        }
    }
}

fn secs(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Whether an entry written at `at` (seconds) still holds at `now`. One
/// from the future (the clock went back) does not.
fn fresh(at: u64, now: SystemTime) -> bool {
    let now = secs(now);
    at <= now && now - at < CACHE_FOR.as_secs()
}

/// Removes the entries (and leftover temporary files) no longer fresh.
fn sweep(dir: &Path, now: SystemTime) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let old = e.metadata().ok().and_then(|m| m.modified().ok()).is_none_or(|m| now.duration_since(m).unwrap_or_default() > CACHE_FOR * 3);
        if old {
            let _ = fs::remove_file(e.path());
        }
    }
}

/// Variables that change how a dynamically linked program loads or behaves.
/// This process may hold capabilities, authenticate.cgi does not: a local
/// user must not get it to print an administrator's name through LD_PRELOAD.
/// The list is glibc's own for setuid programs (unsecvars.h).
fn is_unsafe_env(name: &str) -> bool {
    name.starts_with("LD_")
        || matches!(
            name,
            "GCONV_PATH"
                | "GETCONF_DIR"
                | "HOSTALIASES"
                | "LOCALDOMAIN"
                | "LOCPATH"
                | "MALLOC_TRACE"
                | "NIS_PATH"
                | "NLSPATH"
                | "RESOLV_HOST_CONF"
                | "RES_OPTIONS"
                | "TMPDIR"
                | "TZDIR"
        )
}

/// Whether `user` is listed in `group` of an /etc/group file. DSM user names
/// are case-insensitive.
pub fn is_member(groups: &str, group: &str, user: &str) -> bool {
    groups.lines().any(|line| {
        let mut fields = line.split(':');
        fields.next() == Some(group)
            && fields.nth(2).is_some_and(|members| members.split(',').any(|m| m.eq_ignore_ascii_case(user)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_loader_variables() {
        assert!(is_unsafe_env("LD_PRELOAD"));
        assert!(is_unsafe_env("LD_LIBRARY_PATH"));
        assert!(!is_unsafe_env("HTTP_COOKIE"));
        assert!(!is_unsafe_env("REMOTE_ADDR"));
    }

    #[test]
    fn reads_cookies() {
        let h = "smid=abc; id=S3ss10n; did=dev1;_x=y";
        assert_eq!(cookie(h, "id"), Some("S3ss10n"));
        assert_eq!(cookie(h, "did"), Some("dev1"));
        assert_eq!(cookie(h, "smid"), Some("abc"));
        assert_eq!(cookie(h, "sid"), None);
        assert_eq!(cookie("id=", "id"), None);
        assert_eq!(cookie("", "id"), None);
    }

    #[test]
    fn keys_depend_on_every_part() {
        let k = cache_key("s", "t", "1.2.3.4", None);
        assert_eq!(k.len(), 64);
        assert_eq!(k, cache_key("s", "t", "1.2.3.4", None));
        assert_ne!(k, cache_key("s", "t", "1.2.3.5", None));
        assert_ne!(k, cache_key("s", "u", "1.2.3.4", None));
        assert_ne!(k, cache_key("s", "t", "1.2.3.4", Some("d")));
        // moving bytes from one part to the next changes the key
        assert_ne!(cache_key("st", "", "a", None), cache_key("s", "t", "a", None));
    }

    #[test]
    fn cache_keeps_logins_for_a_while() {
        let dir = std::env::temp_dir().join(format!("synofile-auth-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let cache = Cache::new(dir.join("auth"), &cache_key("s", "t", "a", None));
        let t0 = SystemTime::now();
        assert_eq!(cache.get(t0), None);
        cache.put("Alice", t0);
        assert_eq!(cache.get(t0), Some("Alice".into()));
        assert_eq!(cache.get(t0 + Duration::from_secs(19)), Some("Alice".into()));
        // expired, and never from the future
        assert_eq!(cache.get(t0 + Duration::from_secs(20)), None);
        assert_eq!(cache.get(t0 - Duration::from_secs(1)), None);
        // another login does not see it
        assert_eq!(Cache::new(dir.join("auth"), &cache_key("s", "t", "b", None)).get(t0), None);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&cache.file).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(dir.join("auth")).unwrap().permissions().mode() & 0o777, 0o700);
        // no temporary file left behind
        assert_eq!(fs::read_dir(dir.join("auth")).unwrap().count(), 1);
        // a broken entry is no entry
        fs::write(&cache.file, "garbage").unwrap();
        assert_eq!(cache.get(t0), None);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unwritable_cache_is_no_cache() {
        let cache = Cache::new(PathBuf::from("/proc/synofile-no/auth"), "k");
        let t0 = SystemTime::now();
        cache.put("Alice", t0);
        assert_eq!(cache.get(t0), None);
    }

    #[test]
    fn sweep_removes_old_entries() {
        let dir = std::env::temp_dir().join(format!("synofile-auth-sweep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a"), "x\n1\n").unwrap();
        sweep(&dir, SystemTime::now());
        assert!(dir.join("a").exists());
        sweep(&dir, SystemTime::now() + Duration::from_secs(120));
        assert!(!dir.join("a").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn finds_group_members() {
        let groups = "users:x:100:\nadministrators:x:101:admin,Alice\n";
        assert!(is_member(groups, "administrators", "alice"));
        assert!(is_member(groups, "administrators", "admin"));
        assert!(!is_member(groups, "administrators", "bob"));
        assert!(!is_member(groups, "users", "alice"));
    }
}
