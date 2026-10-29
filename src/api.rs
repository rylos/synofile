//! The routes behind ui/api.cgi.
//!
//! Every request starts as the package user: DSM's login is checked, then
//! the transfer daemon and the preferences are reached as the package. Any
//! route that touches the shared folders first becomes the DSM user, so
//! the kernel decides what that user may read and change.

use std::io::{self, Write};
use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::archive;
use crate::cgi::{self, ApiError, Request};
use crate::identity::{self, User};
use crate::jobs::daemon;
use crate::jobs::protocol::{Op, Policy, RecycleRoot, Spec};
use crate::shares::{self, Share};
use crate::{auth, fsops, transfer};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// The interface build the package ships (build.sh), none in development.
pub const ASSET: Option<&str> = option_env!("SYNOFILE_ASSET");

pub fn serve() -> io::Result<()> {
    let req = Request::from_env();
    crate::lang::set(req.param("lang").unwrap_or("it"));
    let mut out = io::BufWriter::with_capacity(256 * 1024, io::stdout().lock());
    let result = route(&req, &mut out);
    if let Err(err) = result {
        cgi::error(&mut out, &err)?;
    }
    out.flush()
}

fn method(req: &Request, want: &str) -> Result<(), ApiError> {
    if req.method == want { Ok(()) } else { Err(ApiError::new(405, format!("use {want}"))) }
}

fn route(req: &Request, out: &mut impl Write) -> Result<(), ApiError> {
    if req.route == "health" {
        // no login: tells whether setup ran and the daemon is up
        let daemon = daemon::call(&json!({"cmd": "ping"})).ok();
        let on_file = std::env::current_exe().is_ok_and(|exe| crate::caps::on_file(&exe));
        cgi::json(out, 200, &json!({ "version": VERSION, "capabilities": crate::caps::effective(), "on_file": on_file, "daemon": daemon }))?;
        return Ok(());
    }
    let name = auth::require_admin()?;
    let user = identity::lookup(&name)?;
    let shares = shares::all(&user);

    match req.route.as_str() {
        // ---- as the package user ----
        "whoami" => {
            let daemon = daemon::call(&json!({"cmd": "ping"})).ok();
            let setup = crate::caps::effective() || identity::dev();
            reply(out, &json!({ "user": user.name, "version": VERSION, "asset": ASSET, "setup": setup, "daemon": daemon.is_some() }))
        }
        "prefs" => prefs(req, out, &user),
        "jobs" => {
            let since: u64 = req.param("since").and_then(|s| s.parse().ok()).unwrap_or(0);
            let answer = ask_daemon(&json!({ "cmd": "list", "user": user.name, "since": since }))?;
            reply(out, &answer)
        }
        "jobs/new" => {
            method(req, "POST")?;
            let body: NewJob = req.json()?;
            let spec = job_spec(&shares, &body)?;
            let info = daemon::Info { sources: body.sources.clone(), dest: body.dest.clone(), permanent: body.permanent };
            let answer = ask_daemon(&json!({ "cmd": "submit", "user": user, "spec": spec, "info": info, "lang": crate::lang::code() }))?;
            reply(out, &answer)
        }
        "jobs/control" => {
            method(req, "POST")?;
            let mut body: Value = req.json()?;
            body["cmd"] = json!("control");
            body["user"] = json!(user.name);
            body["lang"] = json!(crate::lang::code());
            reply(out, &ask_daemon(&body)?)
        }
        _ => {
            identity::become_user(&user).map_err(|e| ApiError::new(500, format!("cannot become {}: {e}", user.name)))?;
            if !identity::dev() && !crate::caps::none_left() {
                return Err(ApiError::new(500, "capabilities still held after dropping to the user"));
            }
            as_user(req, out, &user, &shares)
        }
    }
}

fn reply(out: &mut impl Write, value: &impl serde::Serialize) -> Result<(), ApiError> {
    cgi::json(out, 200, value)?;
    Ok(())
}

fn ask_daemon(request: &Value) -> Result<Value, ApiError> {
    let answer = daemon::call(request).map_err(|_| {
        ApiError::new(503, t!("il servizio dei trasferimenti non è attivo: avvia SynoFile dal Centro pacchetti", "the transfer service is not running: start SynoFile from Package Center"))
    })?;
    match answer.get("error").and_then(Value::as_str) {
        Some(e) => Err(ApiError::bad_request(e)),
        None => Ok(answer),
    }
}

#[derive(Deserialize)]
struct NewJob {
    op: Op,
    sources: Vec<String>,
    #[serde(default)]
    dest: Option<String>,
    #[serde(default)]
    conflict: Policy,
    #[serde(default)]
    verify: bool,
    #[serde(default)]
    limit: u64,
    #[serde(default)]
    permanent: bool,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    level: Option<String>,
    #[serde(default)]
    into_folder: bool,
    #[serde(default)]
    password: Option<String>,
    /// extract: only these items (paths inside the archive), each into dest
    #[serde(default)]
    members: Vec<String>,
}

fn job_spec(shares: &[Share], body: &NewJob) -> Result<Spec, ApiError> {
    if body.sources.is_empty() {
        return Err(ApiError::bad_request(t!("nessun elemento selezionato", "nothing selected")));
    }
    if body.op == Op::Cleanup {
        return Err(ApiError::bad_request("invalid operation"));
    }
    let mut sources = Vec::new();
    let mut recycle = Vec::new();
    for vpath in &body.sources {
        let r = shares::resolve(shares, vpath)?;
        if r.is_root() {
            return Err(ApiError::bad_request(t!("una cartella condivisa non si copia, sposta o elimina da qui", "a shared folder cannot be copied, moved or deleted from here")));
        }
        if body.op == Op::Delete && !body.permanent && r.share.recycle {
            // a personal home is a folder of the homes share for DSM's recycle bin
            let root = match shares.iter().find(|s| s.name == "homes").filter(|_| r.share.home) {
                Some(homes) => RecycleRoot { name: homes.name.clone(), path: homes.path.clone() },
                None => RecycleRoot { name: r.share.name.clone(), path: r.share.path.clone() },
            };
            if !recycle.iter().any(|x: &RecycleRoot| x.name == root.name) {
                recycle.push(root);
            }
        }
        sources.push(r.real);
    }
    let dest = match (&body.dest, body.op) {
        (_, Op::Delete) => None,
        (Some(d), _) => Some(shares::resolve(shares, d)?.real),
        (None, _) => return Err(ApiError::bad_request(t!("manca la destinazione", "no destination"))),
    };
    if let Some(name) = &body.name {
        shares::valid_name(name)?;
    }
    if body.op == Op::Extract && sources.len() != 1 {
        return Err(ApiError::bad_request(t!("si estrae un archivio alla volta", "one archive at a time")));
    }
    Ok(Spec {
        op: body.op,
        sources,
        dest,
        conflict: body.conflict,
        verify: body.verify,
        limit: body.limit,
        recycle,
        lang: crate::lang::code().into(),
        name: body.name.clone(),
        level: body.level.clone(),
        into_folder: body.into_folder,
        password: body.password.clone(),
        members: body.members.iter().map(|m| valid_member(m)).collect::<Result<_, _>>()?,
    })
}

/// A path inside an archive, as the client sends it: plain components only.
fn valid_member(m: &str) -> Result<String, ApiError> {
    let parts: Vec<&str> = m.split('/').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() || parts.iter().any(|p| *p == "." || *p == ".." || p.contains('\0')) {
        return Err(ApiError::bad_request("invalid path"));
    }
    Ok(parts.join("/"))
}

/// A path that goes inside an archive file: the archive, the path inside
/// it, and what the archive holds.
fn in_archive(real: &std::path::Path) -> Result<Option<(PathBuf, String, Vec<archive::Member>)>, ApiError> {
    match archive::locate(real) {
        Some((file, inner)) => {
            let members = archive::members(&file)?;
            Ok(Some((file, inner, members)))
        }
        None => Ok(None),
    }
}

/// One file out of an archive, to show or to download.
fn send_member(out: &mut impl Write, real: &std::path::Path, inline: bool) -> Result<bool, ApiError> {
    let Some((file, inner, members)) = in_archive(real)? else { return Ok(false) };
    if inner.is_empty() {
        return Ok(false);
    }
    let m = archive::find(&members, &inner).ok_or_else(|| ApiError::not_found(t!("elemento non trovato nell'archivio", "item not found in the archive")))?;
    transfer::send_command(out, archive::cat(&file, m), &inner, m.size, m.mtime, inline)?;
    Ok(true)
}

fn prefs(req: &Request, out: &mut impl Write, user: &User) -> Result<(), ApiError> {
    let dir = crate::var_dir().join("prefs");
    let file = dir.join(format!("{}.json", user.name.to_lowercase().replace(['/', '.'], "_")));
    if req.method == "POST" {
        let value: Value = req.json()?;
        let text = serde_json::to_vec(&value).map_err(|e| ApiError::bad_request(e.to_string()))?;
        if text.len() > 256 * 1024 {
            return Err(ApiError::bad_request(t!("preferenze troppo grandi", "preferences too large")));
        }
        std::fs::create_dir_all(&dir)?;
        let tmp = file.with_extension("tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(tmp, &file)?;
        return reply(out, &json!({ "ok": true }));
    }
    let value: Value = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(json!({}));
    reply(out, &value)
}

#[derive(Deserialize)]
struct Paths {
    paths: Vec<String>,
}

fn as_user(req: &Request, out: &mut impl Write, user: &User, shares: &[Share]) -> Result<(), ApiError> {
    let path_param = |name: &str| -> Result<PathBuf, ApiError> { Ok(shares::resolve(shares, req.require(name)?)?.real) };
    match req.route.as_str() {
        "shares" => {
            let list: Vec<Value> = shares
                .iter()
                .map(|s| {
                    let (free, total) = fsops::space(&s.path).unwrap_or((0, 0));
                    let mut v = serde_json::to_value(s).unwrap_or_default();
                    v["free"] = json!(free);
                    v["total"] = json!(total);
                    v["readable"] = json!(fsops::access(&s.path, libc::R_OK | libc::X_OK));
                    v["writable"] = json!(fsops::access(&s.path, libc::W_OK | libc::X_OK));
                    v
                })
                .collect();
            reply(out, &json!({ "shares": list, "user": user.name }))
        }
        "list" => {
            let r = shares::resolve(shares, req.require("path")?)?;
            if let Some((_, inner, members)) = in_archive(&r.real)? {
                if !archive::is_dir(&members, &inner) {
                    return Err(ApiError::bad_request(t!("non è una cartella", "not a folder")));
                }
                let (files, dirs, bytes) = archive::usage(&members, &inner);
                let total = json!({ "files": files, "dirs": dirs, "bytes": bytes });
                return reply(out, &json!({ "entries": archive::children(&members, &inner), "writable": false, "space": null, "recycle": false, "inner": inner, "total": total }));
            }
            let listing = fsops::list(&r.real)?;
            let space = fsops::space(&r.real).map(|(free, total)| json!({"free": free, "total": total}));
            reply(
                out,
                &json!({ "entries": listing.entries, "writable": listing.writable, "space": space, "recycle": r.share.recycle }),
            )
        }
        "stat" => {
            let real = path_param("path")?;
            if let Some((file, inner, members)) = in_archive(&real)? {
                if !inner.is_empty() {
                    let m = archive::find(&members, &inner);
                    let name = inner.rsplit('/').next().unwrap_or_default();
                    let archive_name = file.file_name().unwrap_or_default().to_string_lossy();
                    return reply(out, &json!({ "name": name, "kind": if m.is_some() { "f" } else { "d" }, "size": m.map_or(0, |m| m.size), "mtime": m.map_or(0, |m| m.mtime), "mode": m.map_or(0o755, |m| m.mode), "owner": archive_name, "group": "", "archive": true }));
                }
            }
            reply(out, &fsops::details(&real)?)
        }
        "usage" => {
            method(req, "POST")?;
            let body: Paths = req.json()?;
            let paths = body.paths.iter().map(|p| Ok(shares::resolve(shares, p)?.real)).collect::<Result<Vec<_>, ApiError>>()?;
            // folders inside an archive are counted from its listing
            if let [one] = paths.as_slice() {
                if let Some((_, inner, members)) = in_archive(one)? {
                    if !inner.is_empty() {
                        let (files, dirs, bytes) = archive::usage(&members, &inner);
                        return reply(out, &json!({ "bytes": bytes, "files": files, "dirs": dirs + 1, "unreadable": 0, "partial": false }));
                    }
                }
            }
            reply(out, &fsops::usage(&paths, Duration::from_secs(25)))
        }
        "mkdir" => {
            method(req, "POST")?;
            let dir = path_param("path")?;
            let name = req.require("name")?;
            shares::valid_name(name)?;
            if req.param("parents") == Some("1") {
                // folder uploads: the whole relative path, created as needed
                let mut path = dir;
                for part in name.split('/') {
                    shares::valid_name(part)?;
                    path.push(part);
                }
                std::fs::create_dir_all(&path)?;
            } else {
                fsops::mkdir(&dir.join(name))?;
            }
            reply(out, &json!({ "ok": true }))
        }
        "rename" => {
            method(req, "POST")?;
            let r = shares::resolve(shares, req.require("path")?)?;
            if r.is_root() {
                return Err(ApiError::bad_request(t!("una cartella condivisa si rinomina dal Pannello di controllo", "a shared folder is renamed in Control Panel")));
            }
            let name = req.require("name")?;
            shares::valid_name(name)?;
            let target = r.real.with_file_name(name);
            fsops::rename(&r.real, &target)?;
            reply(out, &json!({ "ok": true }))
        }
        "search" => {
            let root = path_param("path")?;
            if archive::locate(&root).is_some() {
                return Err(ApiError::bad_request(t!("la ricerca nelle sottocartelle non funziona dentro un archivio", "subfolder search does not work inside an archive")));
            }
            let pattern = fsops::Pattern::new(req.require("q")?);
            let limit = req.param("limit").and_then(|l| l.parse().ok()).unwrap_or(2000).min(10000);
            let budget = req.param("budget").and_then(|b| b.parse().ok()).unwrap_or(15u64).clamp(1, 60);
            reply(out, &fsops::search(&root, &pattern, limit, Duration::from_secs(budget)))
        }
        "download" => {
            if let Some(list) = req.param("paths") {
                let paths: Vec<String> = serde_json::from_str(list).map_err(|_| ApiError::bad_request("paths"))?;
                let real = paths.iter().map(|p| Ok(shares::resolve(shares, p)?.real)).collect::<Result<Vec<_>, ApiError>>()?;
                if real.len() == 1 && send_member(out, &real[0], false)? {
                    return Ok(());
                }
                if real.len() == 1 && std::fs::metadata(&real[0]).is_ok_and(|m| m.is_file()) {
                    return transfer::send_file(out, req, &real[0], false);
                }
                let name = match real.as_slice() {
                    [one] => one.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    many => many[0]
                        .parent()
                        .and_then(|p| p.file_name())
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "download".into()),
                };
                if req.param("format") == Some("tar") {
                    return transfer::send_tar(out, &real, &format!("{name}.tar"));
                }
                return transfer::send_zip(out, &real, &format!("{name}.zip"));
            }
            let real = path_param("path")?;
            if send_member(out, &real, false)? {
                return Ok(());
            }
            transfer::send_file(out, req, &real, false)
        }
        "view" => {
            let real = path_param("path")?;
            if send_member(out, &real, true)? {
                return Ok(());
            }
            transfer::send_file(out, req, &real, true)
        }
        "thumb" => {
            let file = path_param("path")?;
            let thumb = fsops::thumbnail(&file, req.param("size") == Some("big")).ok_or_else(|| ApiError::not_found(t!("nessuna miniatura", "no thumbnail")))?;
            let data = std::fs::read(thumb)?;
            let length = data.len().to_string();
            write!(
                out,
                "Status: 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: {length}\r\nCache-Control: private, max-age=86400\r\n\r\n"
            )?;
            out.write_all(&data)?;
            Ok(())
        }
        "text" => {
            // the first part of a text file, for the preview
            let path = path_param("path")?;
            let mut buf = Vec::new();
            use std::io::Read;
            let size = match in_archive(&path)? {
                Some((file, inner, members)) if !inner.is_empty() => {
                    let m = archive::find(&members, &inner).ok_or_else(|| ApiError::not_found(t!("elemento non trovato nell'archivio", "item not found in the archive")))?;
                    let mut child = archive::cat(&file, m).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn()?;
                    child.stdout.take().unwrap().take(512 * 1024).read_to_end(&mut buf)?;
                    let _ = child.kill();
                    let _ = child.wait();
                    m.size
                }
                _ => {
                    std::fs::File::open(&path)?.take(512 * 1024).read_to_end(&mut buf)?;
                    std::fs::metadata(&path)?.len()
                }
            };
            let binary = buf.iter().take(8192).any(|&b| b == 0);
            reply(out, &json!({ "text": if binary { String::new() } else { String::from_utf8_lossy(&buf).into_owned() }, "binary": binary, "size": size, "truncated": size > buf.len() as u64 }))
        }
        "upload" => {
            method(req, "POST")?;
            let dir = path_param("dir")?;
            let name = req.require("name")?;
            shares::valid_name(name)?;
            reply(out, &transfer::upload(req, &dir, name)?)
        }
        "upload/abort" => {
            method(req, "POST")?;
            let dir = path_param("dir")?;
            let name = req.require("name")?;
            shares::valid_name(name)?;
            let _ = std::fs::remove_file(transfer::upload_part(&dir, name));
            reply(out, &json!({ "ok": true }))
        }
        "upload/status" => {
            let dir = path_param("dir")?;
            let name = req.require("name")?;
            shares::valid_name(name)?;
            let have = std::fs::metadata(transfer::upload_part(&dir, name)).map(|m| m.len()).unwrap_or(0);
            let exists = std::fs::symlink_metadata(dir.join(name)).is_ok();
            reply(out, &json!({ "received": have, "exists": exists }))
        }
        "exists" => {
            // which of these names are taken in a folder: the upload asks before sending
            method(req, "POST")?;
            let dir = path_param("path")?;
            let names: Vec<String> = req.json()?;
            let taken: Vec<Value> = names
                .iter()
                .filter(|n| shares::valid_name(n).is_ok())
                .filter_map(|n| {
                    let m = std::fs::symlink_metadata(dir.join(n)).ok()?;
                    use std::os::unix::fs::MetadataExt;
                    Some(json!({ "name": n, "size": m.len(), "mtime": m.mtime(), "dir": m.is_dir() }))
                })
                .collect();
            reply(out, &json!({ "taken": taken }))
        }
        _ => Err(ApiError::not_found(format!("no route {}", req.route))),
    }
}
