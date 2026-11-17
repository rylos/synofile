//! A file's checksum, computed on the NAS. The answer is a stream of JSON
//! lines, `{"done":N,"size":S}` about every half second, then `{"hash":"…"}`
//! or `{"error":"…"}`: a big file takes minutes, and a web server that
//! hears nothing for a minute closes the request.

use std::fs::File;
use std::io::{self, Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use sha2::Digest;

use crate::cgi::{self, ApiError};

const CHUNK: usize = 1 << 20;

enum Hasher {
    Sha256(sha2::Sha256),
    Sha1(sha1::Sha1),
    Md5(md5::Md5),
    Xxh128(Box<xxhash_rust::xxh3::Xxh3>),
}

impl Hasher {
    fn new(algo: &str) -> Option<Self> {
        Some(match algo {
            "sha256" => Self::Sha256(sha2::Sha256::new()),
            "sha1" => Self::Sha1(sha1::Sha1::new()),
            "md5" => Self::Md5(md5::Md5::new()),
            "xxh128" => Self::Xxh128(Box::default()),
            _ => return None,
        })
    }

    fn update(&mut self, data: &[u8]) {
        match self {
            Self::Sha256(h) => h.update(data),
            Self::Sha1(h) => h.update(data),
            Self::Md5(h) => h.update(data),
            Self::Xxh128(h) => h.update(data),
        }
    }

    fn hex(self) -> String {
        match self {
            Self::Sha256(h) => hex(&h.finalize()),
            Self::Sha1(h) => hex(&h.finalize()),
            Self::Md5(h) => hex(&h.finalize()),
            // as xxhsum -H2 prints it: the 128 bits, big-endian
            Self::Xxh128(h) => hex(&h.digest128().to_be_bytes()),
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The checksum of `file` with `algo`: sha256, sha1, md5 or xxh128.
pub fn send(out: &mut impl Write, file: &Path, algo: &str) -> Result<(), ApiError> {
    let hasher = Hasher::new(algo).ok_or_else(|| ApiError::bad_request("algo"))?;
    let meta = std::fs::metadata(file)?;
    if !meta.is_file() {
        return Err(ApiError::bad_request(t!("il checksum si calcola solo sui file", "a checksum is computed on files only")));
    }
    let input = File::open(file)?;
    cgi::head(out, 200, &[("Content-Type", "application/x-ndjson"), ("X-Accel-Buffering", "no")])?;
    out.flush()?;
    let line = match hash(input, hasher, meta.len(), out) {
        Ok(hash) => serde_json::json!({ "hash": hash }),
        Err(e) if e.kind() == io::ErrorKind::BrokenPipe => return Ok(()),
        Err(e) => serde_json::json!({ "error": crate::fsops::describe(&e) }),
    };
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
    Ok(())
}

fn hash(mut input: File, mut hasher: Hasher, size: u64, out: &mut impl Write) -> io::Result<String> {
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    let mut told = Instant::now();
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        done += n as u64;
        if told.elapsed() >= Duration::from_millis(500) {
            told = Instant::now();
            writeln!(out, "{}", serde_json::json!({ "done": done, "size": size }))?;
            out.flush()?;
        }
    }
    Ok(hasher.hex())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn of(algo: &str, data: &[u8]) -> String {
        let mut h = Hasher::new(algo).unwrap();
        h.update(data);
        h.hex()
    }

    #[test]
    fn known_values() {
        assert_eq!(of("sha256", b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(of("sha1", b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(of("md5", b"abc"), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(of("xxh128", b""), "99aa06d3014798d86001c324468d497f");
    }
}
