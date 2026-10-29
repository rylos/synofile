//! DSM users as the kernel knows them, and becoming one.

use std::fs;
use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub name: String,
    pub uid: u32,
    pub gid: u32,
    pub groups: Vec<u32>,
    pub home: PathBuf,
}

/// Whether this is a development build serving a fake user, which runs
/// everything as whoever started it.
pub fn dev() -> bool {
    cfg!(debug_assertions) && std::env::var_os("SYNOFILE_DEV_USER").is_some()
}

/// Looks `name` up in /etc/passwd and /etc/group. DSM user names are
/// case-insensitive; the passwd spelling wins.
pub fn lookup(name: &str) -> io::Result<User> {
    if dev() {
        // SAFETY: plain getters
        let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        return Ok(User { name: name.to_string(), uid, gid, groups: vec![gid], home });
    }
    let passwd = fs::read_to_string("/etc/passwd")?;
    let groups = fs::read_to_string("/etc/group").unwrap_or_default();
    parse(&passwd, &groups, name).ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("unknown user {name}")))
}

fn parse(passwd: &str, groups: &str, name: &str) -> Option<User> {
    let fields: Vec<&str> = passwd
        .lines()
        .map(|line| line.split(':').collect::<Vec<_>>())
        .find(|f| f.len() >= 7 && f[0].eq_ignore_ascii_case(name))?;
    let (uid, gid) = (fields[2].parse().ok()?, fields[3].parse().ok()?);
    let mut list = vec![gid];
    for line in groups.lines() {
        let g: Vec<&str> = line.split(':').collect();
        if g.len() >= 4 && g[3].split(',').any(|m| m.eq_ignore_ascii_case(fields[0])) {
            if let Ok(id) = g[2].parse() {
                if !list.contains(&id) {
                    list.push(id);
                }
            }
        }
    }
    Some(User { name: fields[0].to_string(), uid, gid, groups: list, home: PathBuf::from(fields[5]) })
}

/// The names behind uids and gids, for the properties dialog.
pub fn names(file: &str, id: u32) -> Option<String> {
    let text = fs::read_to_string(file).ok()?;
    text.lines().find_map(|line| {
        let f: Vec<&str> = line.split(':').collect();
        (f.len() > 2 && f[2].parse() == Ok(id)).then(|| f[0].to_string())
    })
}

/// Becomes `user` for good: groups, gid, uid, then no capability left and
/// none to gain through exec. Safe to call between fork and exec: only
/// raw system calls, no allocation.
pub fn become_user(user: &User) -> io::Result<()> {
    if dev() {
        return Ok(());
    }
    become_raw(user.uid, user.gid, &user.groups)
}

pub fn become_raw(uid: u32, gid: u32, groups: &[u32]) -> io::Result<()> {
    // SAFETY: system calls with valid arguments
    unsafe {
        if libc::setgroups(groups.len(), groups.as_ptr()) < 0
            || libc::setresgid(gid, gid, gid) < 0
            || libc::setresuid(uid, uid, uid) < 0
        {
            return Err(io::Error::last_os_error());
        }
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    crate::caps::clear()?;
    // SAFETY: plain getters
    if unsafe { libc::getuid() != uid || libc::geteuid() != uid || libc::getegid() != gid } {
        return Err(io::Error::other("identity change did not take"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_users_and_groups() {
        let passwd = "root:x:0:0::/root:/bin/sh\nAlice:x:1026:100:Alice R:/var/services/homes/Alice:/bin/sh\n";
        let groups = "users:x:100:\nadministrators:x:101:admin,alice\nhttp:x:1023:\n";
        let user = parse(passwd, groups, "alice").unwrap();
        assert_eq!(user.name, "Alice");
        assert_eq!((user.uid, user.gid), (1026, 100));
        assert_eq!(user.groups, vec![100, 101]);
        assert_eq!(user.home, PathBuf::from("/var/services/homes/Alice"));
        assert!(parse(passwd, groups, "nobody").is_none());
    }
}
