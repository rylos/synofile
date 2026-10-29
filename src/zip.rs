//! A zip writer that streams: every entry is written once, front to back,
//! with its sizes in a data descriptor after the data, so the same code
//! feeds a download (no seeking on a pipe) and an archive on disk. Names
//! are UTF-8 (flag bit 11), sizes and offsets go zip64 when they need to,
//! and Unix modes travel in the external attributes.

use std::io::{self, Read, Write};

const LOCAL: u32 = 0x0403_4b50;
const DESCRIPTOR: u32 = 0x0807_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const END: u32 = 0x0605_4b50;
const END64: u32 = 0x0606_4b50;
const LOCATOR64: u32 = 0x0706_4b50;
/// zip64 extra field
const ZIP64: u16 = 0x0001;
const VERSION: u16 = 45;
/// data descriptor follows, names are UTF-8
const FLAGS: u16 = 0x0808;
const MAX32: u64 = 0xffff_ffff;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Level {
    /// no compression: the fastest, for downloads and media
    Store,
    Fast,
    Normal,
}

impl Level {
    pub fn parse(text: &str) -> Self {
        match text {
            "store" => Level::Store,
            "fast" => Level::Fast,
            _ => Level::Normal,
        }
    }
}

/// Extensions whose data is already compressed: deflating them again
/// costs time and saves nothing, so they are stored.
pub fn already_compressed(name: &str) -> bool {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    matches!(
        ext.as_str(),
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "avif" | "heic" | "heif" | "mp4" | "m4v" | "mkv" | "mov" | "avi" | "webm"
            | "mp3" | "m4a" | "aac" | "ogg" | "opus" | "flac" | "zip" | "7z" | "rar" | "gz" | "tgz" | "bz2" | "xz" | "zst"
            | "docx" | "xlsx" | "pptx" | "odt" | "ods" | "epub" | "jar" | "apk" | "iso" | "dmg"
    )
}

struct Central {
    name: Vec<u8>,
    method: u16,
    time: u16,
    date: u16,
    crc: u32,
    csize: u64,
    usize: u64,
    offset: u64,
    external: u32,
}

/// Counts the bytes written through it.
struct Counter<'a, W: Write> {
    inner: &'a mut W,
    n: u64,
}

impl<W: Write> Write for Counter<'_, W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.n += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

pub struct ZipWriter<W: Write> {
    out: W,
    offset: u64,
    entries: Vec<Central>,
    buf: Vec<u8>,
}

impl<W: Write> ZipWriter<W> {
    pub fn new(out: W) -> Self {
        Self { out, offset: 0, entries: Vec::new(), buf: vec![0; 256 * 1024] }
    }

    fn put(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.out.write_all(bytes)?;
        self.offset += bytes.len() as u64;
        Ok(())
    }

    fn local_header(&mut self, name: &[u8], method: u16, (time, date): (u16, u16)) -> io::Result<u64> {
        let offset = self.offset;
        let mut h = Vec::with_capacity(30 + name.len() + 20);
        h.extend(LOCAL.to_le_bytes());
        h.extend(VERSION.to_le_bytes());
        h.extend(FLAGS.to_le_bytes());
        h.extend(method.to_le_bytes());
        h.extend(time.to_le_bytes());
        h.extend(date.to_le_bytes());
        // crc and sizes come in the descriptor; the zip64 extra says it is 64-bit
        h.extend([0u8; 4]);
        h.extend(u32::MAX.to_le_bytes());
        h.extend(u32::MAX.to_le_bytes());
        h.extend((name.len() as u16).to_le_bytes());
        h.extend(20u16.to_le_bytes());
        h.extend(name);
        h.extend(ZIP64.to_le_bytes());
        h.extend(16u16.to_le_bytes());
        h.extend([0u8; 16]);
        self.put(&h)?;
        Ok(offset)
    }

    fn descriptor(&mut self, crc: u32, csize: u64, usize: u64) -> io::Result<()> {
        let mut d = Vec::with_capacity(24);
        d.extend(DESCRIPTOR.to_le_bytes());
        d.extend(crc.to_le_bytes());
        d.extend(csize.to_le_bytes());
        d.extend(usize.to_le_bytes());
        self.put(&d)
    }

    pub fn add_dir(&mut self, name: &str, mtime: i64, mode: u32) -> io::Result<()> {
        let mut name = name.trim_end_matches('/').as_bytes().to_vec();
        name.push(b'/');
        let time = dos_time(mtime);
        let offset = self.local_header(&name, 0, time)?;
        self.descriptor(0, 0, 0)?;
        let external = ((0o040000 | (mode & 0o7777)) << 16) | 0x10;
        self.entries.push(Central { name, method: 0, time: time.0, date: time.1, crc: 0, csize: 0, usize: 0, offset, external });
        Ok(())
    }

    /// One file from `data`; `progress` hears of every chunk read and may
    /// stop the archive by returning an error.
    pub fn add_file(
        &mut self,
        name: &str,
        mtime: i64,
        mode: u32,
        data: &mut impl Read,
        level: Level,
        progress: &mut dyn FnMut(u64) -> io::Result<()>,
    ) -> io::Result<()> {
        let level = if already_compressed(name) { Level::Store } else { level };
        let method = if level == Level::Store { 0 } else { 8 };
        let time = dos_time(mtime);
        let name_bytes = name.as_bytes().to_vec();
        let offset = self.local_header(&name_bytes, method, time)?;
        let mut crc = crc32fast::Hasher::new();
        let mut usize = 0u64;
        let mut buf = std::mem::take(&mut self.buf);
        let csize = {
            let mut counter = Counter { inner: &mut self.out, n: 0 };
            let result = (|| -> io::Result<()> {
                if level == Level::Store {
                    loop {
                        let n = data.read(&mut buf)?;
                        if n == 0 {
                            return Ok(());
                        }
                        crc.update(&buf[..n]);
                        counter.write_all(&buf[..n])?;
                        usize += n as u64;
                        progress(n as u64)?;
                    }
                }
                let compression = flate2::Compression::new(if level == Level::Fast { 1 } else { 6 });
                let mut encoder = flate2::write::DeflateEncoder::new(&mut counter, compression);
                loop {
                    let n = data.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    crc.update(&buf[..n]);
                    encoder.write_all(&buf[..n])?;
                    usize += n as u64;
                    progress(n as u64)?;
                }
                encoder.finish()?;
                Ok(())
            })();
            self.buf = buf;
            result?;
            counter.n
        };
        self.offset += csize;
        let crc = crc.finalize();
        self.descriptor(crc, csize, usize)?;
        let external = ((0o100000 | (mode & 0o7777)) << 16) | if mode & 0o200 == 0 { 0x01 } else { 0 };
        self.entries.push(Central { name: name_bytes, method, time: time.0, date: time.1, crc, csize, usize, offset, external });
        Ok(())
    }

    /// A symbolic link, the way Info-ZIP stores one: the target as data.
    pub fn add_symlink(&mut self, name: &str, mtime: i64, target: &str) -> io::Result<()> {
        let time = dos_time(mtime);
        let name_bytes = name.as_bytes().to_vec();
        let offset = self.local_header(&name_bytes, 0, time)?;
        let data = target.as_bytes();
        let crc = crc32fast::hash(data);
        self.put(data)?;
        self.descriptor(crc, data.len() as u64, data.len() as u64)?;
        let external = (0o120777u32) << 16;
        self.entries.push(Central {
            name: name_bytes,
            method: 0,
            time: time.0,
            date: time.1,
            crc,
            csize: data.len() as u64,
            usize: data.len() as u64,
            offset,
            external,
        });
        Ok(())
    }

    /// The central directory and the end records; hands back the output.
    pub fn finish(mut self) -> io::Result<W> {
        let start = self.offset;
        let entries = std::mem::take(&mut self.entries);
        for e in &entries {
            let big = e.usize >= MAX32 || e.csize >= MAX32 || e.offset >= MAX32;
            let mut h = Vec::with_capacity(46 + e.name.len() + 28);
            h.extend(CENTRAL.to_le_bytes());
            h.extend((3u16 << 8 | VERSION).to_le_bytes());
            h.extend(VERSION.to_le_bytes());
            h.extend(FLAGS.to_le_bytes());
            h.extend(e.method.to_le_bytes());
            h.extend(e.time.to_le_bytes());
            h.extend(e.date.to_le_bytes());
            h.extend(e.crc.to_le_bytes());
            let (c32, u32_, o32) = if big { (u32::MAX, u32::MAX, u32::MAX) } else { (e.csize as u32, e.usize as u32, e.offset as u32) };
            h.extend(c32.to_le_bytes());
            h.extend(u32_.to_le_bytes());
            h.extend((e.name.len() as u16).to_le_bytes());
            h.extend((if big { 28u16 } else { 0 }).to_le_bytes());
            h.extend(0u16.to_le_bytes()); // comment
            h.extend(0u16.to_le_bytes()); // disk
            h.extend(0u16.to_le_bytes()); // internal attributes
            h.extend(e.external.to_le_bytes());
            h.extend(o32.to_le_bytes());
            h.extend(&e.name);
            if big {
                h.extend(ZIP64.to_le_bytes());
                h.extend(24u16.to_le_bytes());
                h.extend(e.usize.to_le_bytes());
                h.extend(e.csize.to_le_bytes());
                h.extend(e.offset.to_le_bytes());
            }
            self.put(&h)?;
        }
        let size = self.offset - start;
        let n = entries.len() as u64;
        if n >= 0xffff || start >= MAX32 || size >= MAX32 {
            let at = self.offset;
            let mut z = Vec::with_capacity(76);
            z.extend(END64.to_le_bytes());
            z.extend(44u64.to_le_bytes());
            z.extend((3u16 << 8 | VERSION).to_le_bytes());
            z.extend(VERSION.to_le_bytes());
            z.extend(0u32.to_le_bytes());
            z.extend(0u32.to_le_bytes());
            z.extend(n.to_le_bytes());
            z.extend(n.to_le_bytes());
            z.extend(size.to_le_bytes());
            z.extend(start.to_le_bytes());
            z.extend(LOCATOR64.to_le_bytes());
            z.extend(0u32.to_le_bytes());
            z.extend(at.to_le_bytes());
            z.extend(1u32.to_le_bytes());
            self.put(&z)?;
        }
        let mut e = Vec::with_capacity(22);
        e.extend(END.to_le_bytes());
        e.extend(0u16.to_le_bytes());
        e.extend(0u16.to_le_bytes());
        e.extend((n.min(0xffff) as u16).to_le_bytes());
        e.extend((n.min(0xffff) as u16).to_le_bytes());
        e.extend((size.min(MAX32) as u32).to_le_bytes());
        e.extend((start.min(MAX32) as u32).to_le_bytes());
        e.extend(0u16.to_le_bytes());
        self.put(&e)?;
        self.out.flush()?;
        Ok(self.out)
    }
}

/// MS-DOS time and date, local time, two-second steps, from 1980.
fn dos_time(mtime: i64) -> (u16, u16) {
    // SAFETY: localtime_r with valid pointers
    let tm = unsafe {
        let t: libc::time_t = mtime.max(315_532_800) as libc::time_t;
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        tm
    };
    let time = ((tm.tm_hour as u16) << 11) | ((tm.tm_min as u16) << 5) | ((tm.tm_sec as u16) / 2);
    let year = (tm.tm_year + 1900 - 1980).clamp(0, 127) as u16;
    let date = (year << 9) | (((tm.tm_mon + 1) as u16) << 5) | tm.tm_mday as u16;
    (time, date)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn python_reads_it() {
        let dir = std::env::temp_dir().join(format!("synofile-zip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.zip");
        let mut z = ZipWriter::new(std::fs::File::create(&path).unwrap());
        let mut none = |_n: u64| Ok(());
        z.add_dir("Foto", 1_790_000_000, 0o755).unwrap();
        let text = "ciao ".repeat(10_000);
        z.add_file("Foto/perché è.txt", 1_790_000_000, 0o644, &mut text.as_bytes(), Level::Normal, &mut none).unwrap();
        z.add_file("Foto/img.jpg", 1_790_000_000, 0o644, &mut &b"\xff\xd8 not really"[..], Level::Normal, &mut none).unwrap();
        z.add_file("vuoto", 1_790_000_000, 0o600, &mut &b""[..], Level::Fast, &mut none).unwrap();
        z.add_symlink("Foto/link", 1_790_000_000, "img.jpg").unwrap();
        z.finish().unwrap();
        let check = r#"
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
names = z.namelist()
assert names == ["Foto/", "Foto/perché è.txt", "Foto/img.jpg", "vuoto", "Foto/link"], names
assert z.read("Foto/perché è.txt").decode() == "ciao " * 10000
assert z.getinfo("Foto/perché è.txt").compress_type == 8
assert z.getinfo("Foto/img.jpg").compress_type == 0
assert (z.getinfo("vuoto").external_attr >> 16) & 0o777 == 0o600
print("ok")
"#;
        let out = Command::new("python3").arg("-c").arg(check).arg(&path).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ok", "{}", String::from_utf8_lossy(&out.stderr));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
