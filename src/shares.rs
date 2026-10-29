//! The shared folders, and the virtual paths the interface uses: the first
//! component names a share ("/Documenti/2026/fattura.pdf"), the rest is a
//! path inside it. "home" is the user's own home folder, as in File Station.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::cgi::ApiError;
use crate::identity::User;

const SHARE_CONF: &str = "/etc/samba/smb.share.conf";
pub const HOME: &str = "home";
pub const RECYCLE: &str = "#recycle";

#[derive(Debug, Clone, Serialize)]
pub struct Share {
    pub name: String,
    #[serde(skip)]
    pub path: PathBuf,
    pub volume: String,
    pub comment: String,
    pub recycle: bool,
    pub hidden: bool,
    pub encrypted: bool,
    pub home: bool,
}

/// Every share whose folder exists right now: an encrypted share that is
/// not mounted has none.
pub fn all(user: &User) -> Vec<Share> {
    let mut shares = match std::env::var_os("SYNOFILE_DEV_ROOT").filter(|_| cfg!(debug_assertions)) {
        Some(root) => dev_shares(Path::new(&root)),
        None => parse(&fs::read_to_string(SHARE_CONF).unwrap_or_default()),
    };
    shares.retain(|s| s.path.is_dir());
    shares.sort_by_key(|s| s.name.to_lowercase());
    let homes = shares.iter().find(|s| s.name == "homes").cloned();
    if let Some(homes) = homes {
        if user.home.is_dir() {
            shares.insert(
                0,
                Share { name: HOME.into(), path: user.home.clone(), comment: String::new(), home: true, ..homes },
            );
        }
    }
    shares
}

fn dev_shares(root: &Path) -> Vec<Share> {
    let Ok(entries) = fs::read_dir(root) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| Share {
            name: e.file_name().to_string_lossy().into_owned(),
            path: e.path(),
            volume: "volume1".into(),
            comment: String::new(),
            recycle: true,
            hidden: false,
            encrypted: false,
            home: false,
        })
        .collect()
}

/// Reads DSM's share list: one `[name]` section per share, `key=value`
/// lines below it.
fn parse(conf: &str) -> Vec<Share> {
    let mut shares = Vec::new();
    let mut current: Option<Share> = None;
    for line in conf.lines() {
        let line = line.trim();
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            shares.extend(current.take());
            current = Some(Share {
                name: name.to_string(),
                path: PathBuf::new(),
                volume: String::new(),
                comment: String::new(),
                recycle: false,
                hidden: false,
                encrypted: false,
                home: false,
            });
            continue;
        }
        let (Some(share), Some((key, value))) = (current.as_mut(), line.split_once('=')) else { continue };
        let value = value.trim();
        match key.trim() {
            "path" => {
                share.path = PathBuf::from(value);
                share.volume = value.trim_start_matches('/').split('/').next().unwrap_or_default().to_string();
            }
            "comment" => share.comment = value.trim_matches('"').to_string(),
            "enable recycle bin" => share.recycle = value == "yes",
            "browseable" => share.hidden = value == "no",
            _ => {}
        }
    }
    shares.extend(current);
    shares.retain(|s| !s.path.as_os_str().is_empty() && s.name != "global");
    for share in &mut shares {
        // DSM mounts an encrypted share over /volumeN/@name@
        share.encrypted = share.path.parent().is_some_and(|p| p.join(format!("@{}@", share.name)).exists());
    }
    shares
}

/// A path inside a share, checked: no "..", no ".", nothing absolute
/// below the share name.
pub struct Resolved<'a> {
    pub share: &'a Share,
    pub rel: PathBuf,
    pub real: PathBuf,
}

impl Resolved<'_> {
    pub fn is_root(&self) -> bool {
        self.rel.as_os_str().is_empty()
    }
}

pub fn resolve<'a>(shares: &'a [Share], vpath: &str) -> Result<Resolved<'a>, ApiError> {
    if vpath.contains('\0') {
        return Err(ApiError::bad_request("invalid path"));
    }
    let mut parts = vpath.split('/').filter(|p| !p.is_empty());
    let name = parts.next().ok_or_else(|| ApiError::bad_request("a path starts with a shared folder"))?;
    let share = shares
        .iter()
        .find(|s| s.name == name)
        .ok_or_else(|| ApiError::not_found(t!("cartella condivisa {} inesistente", "no shared folder {}", name)))?;
    let mut rel = PathBuf::new();
    for part in parts {
        match Path::new(part).components().next() {
            Some(Component::Normal(_)) if Path::new(part).components().count() == 1 => rel.push(part),
            _ => return Err(ApiError::bad_request("invalid path")),
        }
    }
    let real = share.path.join(&rel);
    Ok(Resolved { share, rel, real })
}

const SPACE_META: &str = "/run/space/space_meta.status";

/// The names given to the volumes in Storage Manager ("volume1" → "M2"),
/// from the status file DSM keeps for everyone to read.
pub fn volume_names() -> std::collections::BTreeMap<String, String> {
    parse_volume_names(&fs::read_to_string(SPACE_META).unwrap_or_default())
}

fn parse_volume_names(text: &str) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    let mut volume: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(section) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            // "/dev/vg4/volume_1" is /volume1; pools have no volume part
            volume = section.rsplit('/').next().and_then(|n| n.strip_prefix("volume_")).filter(|n| n.chars().all(|c| c.is_ascii_digit())).map(|n| format!("volume{n}"));
        } else if let (Some(v), Some(desc)) = (&volume, line.strip_prefix("vol_desc=")) {
            let desc = desc.trim_matches('"').trim();
            if !desc.is_empty() {
                out.insert(v.clone(), desc.to_string());
            }
        }
    }
    out
}

/// Checks that a file name is one component, not empty, not "." or "..".
pub fn valid_name(name: &str) -> Result<(), ApiError> {
    let name_trim = name.trim();
    if name_trim.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\0') {
        return Err(ApiError::bad_request(t!("nome non valido", "invalid name")));
    }
    if name.len() > 255 {
        return Err(ApiError::bad_request(t!("nome troppo lungo (massimo 255 byte)", "name too long (255 bytes at most)")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONF: &str = "[Documenti]\n\tenable recycle bin=yes\n\tpath=/volume1/Documenti\n\tbrowseable=yes\n\tcomment=\"Carte\"\n[0rep_docker]\n\tbrowseable=no\n\tenable recycle bin=no\n\tpath=/volume2/0rep_docker\n";

    #[test]
    fn parses_volume_names() {
        let text = "[/dev/vg4/volume_1]\n\t desc=\"\"\n\t vol_desc=\"M2\"\n[/dev/vg4]\n\t desc=\"Pool-M2\"\n\t vol_desc=\"\"\n[/dev/vg1/volume_2]\n\t vol_desc=\"HDD\"\n[/dev/vg1/volume_3]\n\t vol_desc=\"\"\n";
        let names = parse_volume_names(text);
        assert_eq!(names.get("volume1").map(String::as_str), Some("M2"));
        assert_eq!(names.get("volume2").map(String::as_str), Some("HDD"));
        assert_eq!(names.len(), 2);
    }

    #[test]
    fn parses_share_conf() {
        let shares = parse(CONF);
        assert_eq!(shares.len(), 2);
        assert_eq!(shares[0].name, "Documenti");
        assert_eq!(shares[0].path, PathBuf::from("/volume1/Documenti"));
        assert_eq!(shares[0].volume, "volume1");
        assert_eq!(shares[0].comment, "Carte");
        assert!(shares[0].recycle && !shares[0].hidden);
        assert!(!shares[1].recycle && shares[1].hidden);
    }

    #[test]
    fn resolves_inside_shares() {
        let shares = parse(CONF);
        let r = resolve(&shares, "/Documenti/2026/a b.pdf").unwrap();
        assert_eq!(r.real, PathBuf::from("/volume1/Documenti/2026/a b.pdf"));
        assert_eq!(r.rel, PathBuf::from("2026/a b.pdf"));
        assert!(resolve(&shares, "/Documenti").unwrap().is_root());
        assert!(resolve(&shares, "//Documenti//x/").is_ok());
        assert_eq!(resolve(&shares, "/Documenti/../etc").err().unwrap().status, 400);
        assert_eq!(resolve(&shares, "/Documenti/./x").err().unwrap().status, 400);
        assert_eq!(resolve(&shares, "/Nope/x").err().unwrap().status, 404);
        assert_eq!(resolve(&shares, "/").err().unwrap().status, 400);
    }

    #[test]
    fn checks_names() {
        assert!(valid_name("fattura 2026.pdf").is_ok());
        assert!(valid_name("..").is_err());
        assert!(valid_name("a/b").is_err());
        assert!(valid_name("  ").is_err());
    }
}
