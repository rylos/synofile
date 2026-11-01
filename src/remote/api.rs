//! The API for remote connections: managing them (as the package, which
//! owns the store) and browsing them (any route whose path is `/:<id>/…`).

use std::io::{self, Read, Seek, SeekFrom, Write};

use serde::Deserialize;
use serde_json::{Value, json};

use super::{Conn, Entry, Fs, Kind};
use crate::cgi::{self, ApiError, Request};
use crate::transfer;

fn reply(out: &mut impl Write, value: &impl serde::Serialize) -> Result<(), ApiError> {
    cgi::json(out, 200, value)?;
    Ok(())
}

fn post(req: &Request) -> Result<(), ApiError> {
    if req.method == "POST" { Ok(()) } else { Err(ApiError::new(405, "use POST")) }
}

#[derive(Deserialize)]
struct Edit {
    #[serde(default)]
    id: String,
    name: String,
    kind: Kind,
    host: String,
    #[serde(default)]
    port: u16,
    #[serde(default)]
    domain: String,
    #[serde(default)]
    user: String,
    #[serde(default)]
    auth: String,
    #[serde(default)]
    path: String,
    /// empty keeps the one saved
    #[serde(default)]
    password: String,
    /// "own": a private key pasted or loaded from a file; empty keeps the one
    /// saved
    #[serde(default)]
    private_key: String,
    /// the private key's passphrase, if it has one: used once, to open it
    #[serde(default)]
    passphrase: String,
    /// forget the server's key remembered (it changed, rightly)
    #[serde(default)]
    forget_key: bool,
}

impl Edit {
    /// The connection this edit describes, with the secrets of the saved one.
    fn apply(self, saved: Option<&Conn>) -> Result<Conn, ApiError> {
        let name = self.name.trim();
        let host = self.host.trim().trim_start_matches('\\').trim_end_matches(['\\', '/']);
        if name.is_empty() || name.chars().count() > 80 || name.contains(['\0', '\n']) {
            return Err(ApiError::bad_request(t!("dai un nome alla connessione", "give the connection a name")));
        }
        if host.is_empty() || host.contains(['/', '\\', ' ', '\0']) {
            return Err(ApiError::bad_request(t!("indirizzo del server non valido", "invalid server address")));
        }
        let mut c = saved.cloned().unwrap_or_default();
        let same_server = saved.is_some_and(|s| s.host.eq_ignore_ascii_case(host) && s.port == self.port && s.kind == self.kind);
        c.id = if self.id.is_empty() { super::new_id() } else { self.id };
        c.name = name.to_string();
        c.kind = self.kind;
        c.host = host.to_string();
        c.port = self.port;
        c.domain = self.domain.trim().to_string();
        c.user = self.user.trim().to_string();
        c.auth = match (self.kind, self.auth.as_str()) {
            (Kind::Sftp, "key" | "own") => self.auth.clone(),
            _ => "password".into(),
        };
        if c.auth != "own" {
            c.ssh_key.clear();
            c.key_info.clear();
        } else if !self.private_key.trim().is_empty() {
            let pass = (!self.passphrase.is_empty()).then_some(self.passphrase.as_str());
            let (private, info) = super::sftp::import_key(self.private_key.trim(), pass).map_err(ApiError::bad_request)?;
            c.ssh_key = private;
            c.key_info = info;
        } else if c.ssh_key.is_empty() {
            return Err(ApiError::bad_request(t!("carica la chiave privata, o incollala", "load the private key, or paste it")));
        }
        c.path = self.path.trim().replace('\\', "/").trim_matches('/').to_string();
        if !self.password.is_empty() {
            c.password = self.password;
        }
        if self.forget_key || !same_server {
            c.host_key.clear();
        }
        Ok(c)
    }
}

/// The routes `conns…`, before the CGI becomes the user.
pub fn conns(req: &Request, out: &mut impl Write, user: &str) -> Result<(), ApiError> {
    let mut list = super::load(user);
    match req.route.as_str() {
        "conns" => {
            let key = super::ssh_key(user, false).ok().flatten().map(|(_, public)| public);
            reply(out, &json!({ "conns": list.iter().map(Conn::public).collect::<Vec<_>>(), "key": key }))
        }
        "conns/save" => {
            post(req)?;
            let edit: Edit = req.json()?;
            let saved = list.iter().position(|c| c.id == edit.id && !edit.id.is_empty());
            let mut c = edit.apply(saved.map(|i| &list[i]))?;
            // an SFTP server's key is remembered now, so a later change shows
            if c.kind == Kind::Sftp && c.host_key.is_empty() {
                if let Ok(s) = super::sftp::Sftp::connect(&with_key(user, c.clone())) {
                    c.host_key = s.host_key.clone();
                }
            }
            match saved {
                Some(i) => list[i] = c.clone(),
                None => list.push(c.clone()),
            }
            super::store(user, &list)?;
            reply(out, &json!({ "conn": c.public() }))
        }
        "conns/delete" => {
            post(req)?;
            let body: Value = req.json()?;
            let id = body["id"].as_str().unwrap_or_default();
            list.retain(|c| c.id != id);
            super::store(user, &list)?;
            reply(out, &json!({ "ok": true }))
        }
        "conns/order" => {
            post(req)?;
            let ids: Vec<String> = req.json()?;
            list.sort_by_key(|c| ids.iter().position(|i| *i == c.id).unwrap_or(usize::MAX));
            super::store(user, &list)?;
            reply(out, &json!({ "ok": true }))
        }
        "conns/test" => {
            post(req)?;
            let edit: Edit = req.json()?;
            let saved = list.iter().find(|c| c.id == edit.id && !edit.id.is_empty()).cloned();
            let c = with_key(user, edit.apply(saved.as_ref())?);
            let start = std::time::Instant::now();
            let (fs, home, host_key) = match c.kind {
                Kind::Smb => (c.connect().map_err(ApiError::from)?, String::new(), String::new()),
                Kind::Sftp => {
                    let s = super::sftp::Sftp::connect(&c).map_err(ApiError::from)?;
                    let (home, key) = (s.home.clone(), s.host_key.clone());
                    (Box::new(s) as Box<dyn Fs>, home, key)
                }
            };
            let parts = start_parts(&c, &home);
            let items = fs.list(&parts).map_err(ApiError::from)?;
            reply(out, &json!({ "ok": true, "items": items.len(), "ms": start.elapsed().as_millis() as u64, "home": home, "host_key": host_key, "path": parts.join("/") }))
        }
        "conns/key" => {
            post(req)?;
            let (_, public) = super::ssh_key(user, true)?.ok_or_else(|| ApiError::new(500, "no key"))?;
            reply(out, &json!({ "key": public }))
        }
        _ => Err(ApiError::not_found(format!("no route {}", req.route))),
    }
}

/// The connection with the user's SSH key, when it logs in with it.
pub fn with_key(user: &str, mut c: Conn) -> Conn {
    if c.kind == Kind::Sftp && c.auth == "key" && c.ssh_key.is_empty() {
        c.ssh_key = super::ssh_key(user, false).ok().flatten().map(|(private, _)| private).unwrap_or_default();
    }
    c
}

/// Where a connection opens, below its root.
fn start_parts(c: &Conn, home: &str) -> Vec<String> {
    let path = if c.path.is_empty() && c.kind == Kind::Sftp { home } else { &c.path };
    path.split('/').filter(|p| !p.is_empty()).map(String::from).collect()
}

/// The remote path a request is about, if it is about one.
fn remote_param(req: &Request) -> Option<&str> {
    let p = req.param("path").or(req.param("dir"))?;
    super::split(p).is_some().then_some(p)
}

fn first_of_paths(req: &Request) -> Option<Vec<String>> {
    let list: Vec<String> = serde_json::from_str(req.param("paths")?).ok()?;
    list.first().is_some_and(|p| super::split(p).is_some()).then_some(list)
}

/// Opens the connection a path names.
fn open<'a>(conns: &'a [Conn], vpath: &str) -> Result<(&'a Conn, Box<dyn Fs>, Vec<String>), ApiError> {
    let (id, parts) = super::split(vpath).ok_or_else(|| ApiError::bad_request("invalid path"))??;
    let conn = conns
        .iter()
        .find(|c| c.id == id)
        .ok_or_else(|| ApiError::not_found(t!("connessione inesistente: è stata eliminata?", "no such connection: was it deleted?")))?;
    let fs = conn.connect().map_err(ApiError::from)?;
    Ok((conn, fs, parts))
}

/// A route about a remote path, or None for the shared folders.
pub fn serve(req: &Request, out: &mut impl Write, conns: &[Conn]) -> Option<Result<(), ApiError>> {
    if req.route == "download" {
        if let Some(paths) = first_of_paths(req) {
            return Some(download(req, out, conns, &paths));
        }
    }
    let vpath = remote_param(req)?;
    Some(route(req, out, conns, vpath))
}

fn route(req: &Request, out: &mut impl Write, conns: &[Conn], vpath: &str) -> Result<(), ApiError> {
    match req.route.as_str() {
        "list" => {
            let (conn, fs, parts) = open(conns, vpath)?;
            let entries = fs.list(&parts)?;
            let top = fs.is_top(&parts);
            let space = if top { None } else { fs.space(&parts) }.map(|(free, total)| json!({"free": free, "total": total}));
            reply(out, &json!({ "entries": entries, "writable": !top, "space": space, "recycle": false, "remote": { "kind": conn.kind, "top": top } }))
        }
        "stat" => {
            let (conn, fs, parts) = open(conns, vpath)?;
            let e = fs.stat(&parts)?;
            let name = if parts.is_empty() { conn.name.clone() } else { e.name.clone() };
            reply(out, &json!({ "name": name, "kind": e.kind, "size": e.size, "mtime": e.mtime, "mode": e.mode, "owner": "", "group": "", "remote": true, "server": conn.host }))
        }
        "download" | "view" => {
            let (_, fs, parts) = open(conns, vpath)?;
            if fs.stat(&parts)?.is_dir() {
                return zip(out, fs.as_ref(), &[parts]);
            }
            send(out, req, fs.as_ref(), &parts, req.route == "view")
        }
        "text" => {
            let (_, fs, parts) = open(conns, vpath)?;
            let mut r = fs.reader(&parts)?;
            let size = r.len();
            let mut buf = Vec::new();
            r.by_ref().take(512 * 1024).read_to_end(&mut buf)?;
            let binary = buf.iter().take(8192).any(|&b| b == 0);
            reply(out, &json!({ "text": if binary { String::new() } else { String::from_utf8_lossy(&buf).into_owned() }, "binary": binary, "size": size, "truncated": size > buf.len() as u64 }))
        }
        "mkdir" => {
            post(req)?;
            let (_, fs, parts) = open(conns, vpath)?;
            let name = req.require("name")?;
            if req.param("parents") == Some("1") {
                let mut path = parts;
                for part in name.split('/') {
                    super::valid_name(part)?;
                    path.push(part.to_string());
                    match fs.mkdir(&path) {
                        Err(e) if e.raw_os_error() != Some(libc::EEXIST) => return Err(e.into()),
                        _ => {}
                    }
                }
            } else {
                super::valid_name(name)?;
                let mut path = parts;
                path.push(name.to_string());
                fs.mkdir(&path).map_err(|e| {
                    if e.raw_os_error() == Some(libc::EEXIST) { ApiError::conflict(t!("esiste già un elemento con questo nome", "an item with this name already exists")) } else { e.into() }
                })?;
            }
            reply(out, &json!({ "ok": true }))
        }
        "rename" => {
            post(req)?;
            let (conn, fs, parts) = open(conns, vpath)?;
            if parts.is_empty() || (conn.kind == Kind::Smb && parts.len() == 1) {
                return Err(ApiError::bad_request(t!("questo si rinomina sul server", "this is renamed on the server")));
            }
            let name = req.require("name")?;
            super::valid_name(name)?;
            let mut to = parts.clone();
            *to.last_mut().unwrap() = name.to_string();
            fs.rename(&parts, &to)?;
            reply(out, &json!({ "ok": true }))
        }
        "exists" => {
            post(req)?;
            let (_, fs, parts) = open(conns, vpath)?;
            let names: Vec<String> = req.json()?;
            // one listing answers for every name
            let here: Vec<Entry> = fs.list(&parts).unwrap_or_default();
            let taken: Vec<Value> = names
                .iter()
                .filter_map(|n| here.iter().find(|e| e.name == *n))
                .map(|e| json!({ "name": e.name, "size": e.size, "mtime": e.mtime, "dir": e.is_dir() }))
                .collect();
            reply(out, &json!({ "taken": taken }))
        }
        "upload" => {
            post(req)?;
            let (_, fs, dir) = open(conns, vpath)?;
            let name = req.require("name")?;
            super::valid_name(name)?;
            reply(out, &upload(req, fs.as_ref(), &dir, name)?)
        }
        "upload/status" => {
            let (_, fs, dir) = open(conns, vpath)?;
            let name = req.require("name")?;
            super::valid_name(name)?;
            let have = fs.stat(&child(&dir, &part_name(name))).map(|e| e.size).unwrap_or(0);
            let exists = fs.stat(&child(&dir, name)).is_ok();
            reply(out, &json!({ "received": have, "exists": exists }))
        }
        "upload/abort" => {
            post(req)?;
            let (_, fs, dir) = open(conns, vpath)?;
            let name = req.require("name")?;
            super::valid_name(name)?;
            let _ = fs.remove(&child(&dir, &part_name(name)), false);
            reply(out, &json!({ "ok": true }))
        }
        "thumb" => Err(ApiError::not_found(t!("nessuna miniatura", "no thumbnail"))),
        "search" | "space" => Err(ApiError::bad_request(t!("non disponibile sulle connessioni remote", "not available on remote connections"))),
        _ => Err(ApiError::not_found(format!("no route {}", req.route))),
    }
}

fn child(dir: &[String], name: &str) -> Vec<String> {
    let mut p = dir.to_vec();
    p.push(name.to_string());
    p
}

pub fn part_name(name: &str) -> String {
    format!(".{name}.synofile-upload")
}

/// Sizes of remote items, for the info panel.
pub fn usage(out: &mut impl Write, conns: &[Conn], paths: &[String]) -> Result<(), ApiError> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(25);
    let (_, fs, _) = open(conns, paths.first().map(String::as_str).unwrap_or_default())?;
    let (mut bytes, mut files, mut dirs, mut unreadable, mut partial) = (0u64, 0u64, 0u64, 0u64, false);
    let mut stack = Vec::new();
    for p in paths {
        let (_, parts) = super::split(p).ok_or_else(|| ApiError::bad_request("invalid path"))??;
        match fs.stat(&parts) {
            Ok(e) if e.is_dir() => stack.push(parts),
            Ok(e) => {
                files += 1;
                bytes += e.size;
            }
            Err(_) => unreadable += 1,
        }
    }
    while let Some(dir) = stack.pop() {
        if std::time::Instant::now() > deadline {
            partial = true;
            break;
        }
        dirs += 1;
        match fs.list(&dir) {
            Ok(items) => {
                for e in items {
                    if e.is_dir() {
                        stack.push(child(&dir, &e.name));
                    } else {
                        files += 1;
                        bytes += e.size;
                    }
                }
            }
            Err(_) => unreadable += 1,
        }
    }
    reply(out, &json!({ "bytes": bytes, "files": files, "dirs": dirs, "unreadable": unreadable, "partial": partial }))
}

fn download(req: &Request, out: &mut impl Write, conns: &[Conn], paths: &[String]) -> Result<(), ApiError> {
    let (_, fs, first) = open(conns, &paths[0])?;
    let mut all = Vec::new();
    for p in paths {
        let (_, parts) = super::split(p).ok_or_else(|| ApiError::bad_request("invalid path"))??;
        all.push(parts);
    }
    if all.len() == 1 && !fs.stat(&first)?.is_dir() {
        return send(out, req, fs.as_ref(), &first, false);
    }
    zip(out, fs.as_ref(), &all)
}

/// One file, with ranges: video and PDF viewers seek.
fn send(out: &mut impl Write, req: &Request, fs: &dyn Fs, parts: &[String], inline: bool) -> Result<(), ApiError> {
    let e = fs.stat(parts)?;
    let mut r = fs.reader(parts)?;
    let size = r.len();
    let name = parts.last().cloned().unwrap_or_default();
    let content_type = if inline { transfer::mime(&name) } else { "application/octet-stream" };
    let disposition = cgi::disposition(if inline { "inline" } else { "attachment" }, &name);
    let modified = e.mtime.to_string();
    let (status, start, len) = match req.range.as_deref() {
        Some(range) => match cgi::parse_range(range, size) {
            Some((a, b)) => (206, a, b - a + 1),
            None => {
                let unsatisfied = format!("bytes */{size}");
                cgi::head(out, 416, &[("Content-Range", &unsatisfied)])?;
                return Ok(());
            }
        },
        None => (200, 0, size),
    };
    let length = len.to_string();
    let content_range = format!("bytes {start}-{}/{size}", start + len.saturating_sub(1));
    let mut headers = vec![
        ("Content-Type", content_type),
        ("Content-Disposition", disposition.as_str()),
        ("Content-Length", length.as_str()),
        ("Accept-Ranges", "bytes"),
        ("X-Mtime", modified.as_str()),
    ];
    if inline {
        headers.push(("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"));
    }
    if status == 206 {
        headers.push(("Content-Range", content_range.as_str()));
    }
    cgi::head(out, status, &headers)?;
    r.seek(SeekFrom::Start(start))?;
    copy(&mut r.take(len), out)?;
    Ok(())
}

/// Copies in large blocks: each read of a server is a round trip.
fn copy(r: &mut impl Read, w: &mut impl Write) -> io::Result<u64> {
    let mut buf = vec![0u8; 1024 * 1024];
    let mut n = 0;
    loop {
        let k = r.read(&mut buf)?;
        if k == 0 {
            return Ok(n);
        }
        w.write_all(&buf[..k])?;
        n += k as u64;
    }
}

/// Folders, or several items, as one .zip made on the fly.
fn zip(out: &mut impl Write, fs: &dyn Fs, roots: &[Vec<String>]) -> Result<(), ApiError> {
    let name = match roots {
        [one] => one.last().cloned().unwrap_or_else(|| "download".into()),
        many => many[0].iter().rev().nth(1).cloned().unwrap_or_else(|| "download".into()),
    };
    let disposition = cgi::disposition("attachment", &format!("{name}.zip"));
    cgi::head(out, 200, &[("Content-Type", "application/zip"), ("Content-Disposition", &disposition)])?;
    let mut zip = crate::zip::ZipWriter::new(out);
    let mut none = |_n: u64| Ok(());
    for root in roots {
        let base = root.len().saturating_sub(1);
        let Ok(top) = fs.stat(root) else { continue };
        let mut stack = vec![(root.clone(), top)];
        while let Some((path, e)) = stack.pop() {
            let rel = path[base..].join("/");
            if e.is_dir() {
                zip.add_dir(&rel, e.mtime, 0o40755)?;
                let Ok(mut items) = fs.list(&path) else { continue };
                items.sort_by(|a, b| b.name.cmp(&a.name));
                stack.extend(items.into_iter().map(|i| (child(&path, &i.name), i)));
            } else if e.kind == 'f' {
                let Ok(mut r) = fs.reader(&path) else { continue };
                zip.add_file(&rel, e.mtime, 0o100644, &mut r, crate::zip::Level::Store, &mut none)?;
            }
        }
    }
    zip.finish()?;
    Ok(())
}

fn upload(req: &Request, fs: &dyn Fs, dir: &[String], name: &str) -> Result<transfer::UploadState, ApiError> {
    let offset: u64 = req.param("offset").and_then(|v| v.parse().ok()).unwrap_or(0);
    let total: u64 = req.require("total")?.parse().map_err(|_| ApiError::bad_request("total"))?;
    let overwrite = req.param("overwrite") == Some("1");
    if req.length > transfer::MAX_CHUNK || offset + req.length > total {
        return Err(ApiError::bad_request(t!("blocco non valido", "invalid chunk")));
    }
    let target = child(dir, name);
    let part = child(dir, &part_name(name));
    let mut w = if offset == 0 {
        if !overwrite && fs.stat(&target).is_ok() {
            return Err(ApiError::conflict(t!("esiste già", "already exists")));
        }
        fs.writer(&part, None)?
    } else {
        let have = fs.stat(&part).map_err(|_| ApiError::conflict(t!("upload da ricominciare", "the upload has to start again")))?.size;
        if have != offset {
            return Err(ApiError::new(409, format!("offset {have}")));
        }
        fs.writer(&part, Some(offset))?
    };
    let copied = copy(&mut io::stdin().lock().take(req.length), &mut w)?;
    w.finish()?;
    if copied != req.length {
        return Err(ApiError::bad_request(t!("blocco incompleto", "incomplete chunk")));
    }
    let received = offset + copied;
    if received < total {
        return Ok(transfer::UploadState { received, done: false });
    }
    if let Some(mtime) = req.param("mtime").and_then(|m| m.parse::<i64>().ok()) {
        fs.set_mtime(&part, mtime);
    }
    if overwrite && fs.stat(&target).is_ok_and(|e| !e.is_dir()) {
        fs.remove(&target, false)?;
    }
    fs.rename(&part, &target).map_err(|e| {
        let _ = fs.remove(&part, false);
        ApiError::from(e)
    })?;
    Ok(transfer::UploadState { received, done: true })
}
