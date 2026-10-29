//! The CGI side of a request: DSM's web server runs the program once per
//! request, with the request in the environment and the body on stdin.

use std::collections::HashMap;
use std::env;
use std::io::{self, Read, Write};

use serde::Serialize;
use serde::de::DeserializeOwned;

/// Largest JSON body accepted: a selection of a few thousand paths.
const MAX_JSON: usize = 4 * 1024 * 1024;

pub struct Request {
    pub method: String,
    /// Path below the CGI, without the leading slash: "list", "jobs"...
    pub route: String,
    pub query: HashMap<String, String>,
    pub length: u64,
    pub range: Option<String>,
}

impl Request {
    pub fn from_env() -> Self {
        let method = env::var("REQUEST_METHOD").unwrap_or_else(|_| "GET".into());
        let route = env::var("PATH_INFO").unwrap_or_default().trim_matches('/').to_string();
        let query = parse_query(&env::var("QUERY_STRING").unwrap_or_default());
        let length = env::var("CONTENT_LENGTH").ok().and_then(|l| l.parse().ok()).unwrap_or(0);
        let range = env::var("HTTP_RANGE").ok().filter(|r| !r.is_empty());
        Self { method, route, query, length, range }
    }

    pub fn param(&self, name: &str) -> Option<&str> {
        self.query.get(name).map(String::as_str)
    }

    pub fn require(&self, name: &str) -> Result<&str, ApiError> {
        self.param(name).ok_or_else(|| ApiError::bad_request(format!("missing parameter {name}")))
    }

    /// The body as JSON, for the small requests.
    pub fn json<T: DeserializeOwned>(&self) -> Result<T, ApiError> {
        let length = usize::try_from(self.length).unwrap_or(usize::MAX);
        if length > MAX_JSON {
            return Err(ApiError::bad_request("request body too large"));
        }
        let mut body = vec![0; length];
        io::stdin().read_exact(&mut body)?;
        serde_json::from_slice(&body).map_err(|e| ApiError::bad_request(format!("invalid request: {e}")))
    }
}

pub fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(key), percent_decode(value))
        })
        .collect()
}

pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => match (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                (Some(high), Some(low)) => {
                    out.push(high << 4 | low);
                    i += 2;
                }
                _ => out.push(b'%'),
            },
            byte => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(digit: u8) -> Option<u8> {
    (digit as char).to_digit(16).map(|d| d as u8)
}

/// RFC 5987 encoding for the filename* parameter of Content-Disposition.
pub fn percent_encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// An error answered as JSON with an HTTP status.
#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
}

impl ApiError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, message)
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(409, message)
    }
}

impl From<io::Error> for ApiError {
    fn from(e: io::Error) -> Self {
        let status = match e.kind() {
            io::ErrorKind::NotFound => 404,
            io::ErrorKind::PermissionDenied => 403,
            io::ErrorKind::InvalidInput => 400,
            io::ErrorKind::AlreadyExists => 409,
            _ => 500,
        };
        Self::new(status, crate::fsops::describe(&e))
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        206 => "Partial Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        416 => "Range Not Satisfiable",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    }
}

pub fn head(out: &mut impl Write, status: u16, headers: &[(&str, &str)]) -> io::Result<()> {
    write!(out, "Status: {status} {}\r\n", reason(status))?;
    for (name, value) in headers {
        write!(out, "{name}: {value}\r\n")?;
    }
    // API answers are per-user and change constantly
    write!(out, "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\r\n")
}

pub fn json(out: &mut impl Write, status: u16, value: &impl Serialize) -> io::Result<()> {
    let body = serde_json::to_vec(value).map_err(io::Error::other)?;
    let length = body.len().to_string();
    head(
        out,
        status,
        &[("Content-Type", "application/json; charset=utf-8"), ("Content-Length", &length)],
    )?;
    out.write_all(&body)
}

pub fn error(out: &mut impl Write, err: &ApiError) -> io::Result<()> {
    json(out, err.status, &serde_json::json!({ "error": err.message }))
}

pub fn disposition(kind: &str, filename: &str) -> String {
    // ASCII fallback for old clients, the exact name in filename*
    let fallback: String = filename
        .chars()
        .map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' { c } else { '_' })
        .collect();
    format!("{kind}; filename=\"{fallback}\"; filename*=UTF-8''{}", percent_encode(filename))
}

/// The byte range a `Range: bytes=a-b` header asks of a body of `size`
/// bytes: only single ranges, which is what players and PDF viewers send.
pub fn parse_range(header: &str, size: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let (start, end) = match (start.trim(), end.trim()) {
        ("", "") => return None,
        ("", suffix) => {
            let n: u64 = suffix.parse().ok()?;
            (size.saturating_sub(n), size.checked_sub(1)?)
        }
        (s, "") => (s.parse().ok()?, size.checked_sub(1)?),
        (s, e) => (s.parse().ok()?, e.parse::<u64>().ok()?.min(size.checked_sub(1)?)),
    };
    (start <= end && end < size).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_queries() {
        let q = parse_query("path=%2FDocumenti%2Fa+b%2F%C3%A8&bad=%zz&x");
        assert_eq!(q["path"], "/Documenti/a b/è");
        assert_eq!(q["bad"], "%zz");
        assert_eq!(q["x"], "");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%4"), "%4");
    }

    #[test]
    fn encodes_filenames() {
        assert_eq!(percent_encode("café è.txt"), "caf%C3%A9%20%C3%A8.txt");
    }

    #[test]
    fn parses_ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=0-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=0-1,5-6", 1000), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
    }
}
