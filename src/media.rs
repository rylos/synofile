//! What the info panel shows about a photo, a video or a song: size in
//! pixels, duration, codecs, and the camera's EXIF (lens, exposure, place).
//! EXIF and the tracks of MP4/MOV/MKV are read in Rust; codecs and bitrate
//! come from DSM's own ffmpeg (/usr/bin/ffmpeg, part of DSM 7), asked only
//! to describe the file. Without it those lines are just left out.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use nom_exif::{EntryValue, ExifTag, GPSInfo, MediaKind, MediaParser, MediaSource, TrackInfoTag};
use serde_json::{Map, Value, json};

const FFMPEG: &str = "/usr/bin/ffmpeg";
/// ffmpeg reads only the header, but a file on a sleeping disk takes a while
const FFMPEG_WAIT: Duration = Duration::from_secs(8);

/// Everything known about the file; an empty object when it is not media.
pub fn describe(path: &Path) -> Value {
    let mut out = Map::new();
    let name = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
    let ext = name.rsplit_once('.').map_or("", |(_, e)| e);
    let av = is_av(ext);
    if let Ok(ms) = std::fs::File::open(path).map_err(nom_exif::Error::from).and_then(MediaSource::seekable) {
        let mut parser = MediaParser::new();
        match ms.kind() {
            MediaKind::Image => {
                if let Ok(iter) = parser.parse_exif(ms) {
                    exif(&nom_exif::Exif::from(iter), &mut out);
                }
            }
            MediaKind::Track => {
                if let Ok(track) = parser.parse_track(ms) {
                    track_info(&track, &mut out);
                }
            }
        }
    }
    if av && let Some(text) = ffmpeg(path) {
        // ffmpeg knows better for what both read: codecs, exact size, bitrate
        for (k, v) in parse_ffmpeg(&text) {
            out.insert(k, v);
        }
    }
    Value::Object(out)
}

fn is_av(ext: &str) -> bool {
    matches!(
        ext,
        "mp4" | "m4v" | "mov" | "mkv" | "webm" | "avi" | "wmv" | "flv" | "mpg" | "mpeg" | "ts" | "m2ts" | "mts" | "3gp" | "ogv"
            | "mp3" | "m4a" | "aac" | "flac" | "wav" | "ogg" | "opus" | "wma" | "aiff" | "aif" | "alac" | "ape" | "dsf"
    )
}

fn text(v: Option<&EntryValue>) -> Option<String> {
    let s = v?.as_str()?.trim().trim_matches('\0').trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn number(v: Option<&EntryValue>) -> Option<f64> {
    let v = v?;
    v.as_urational()
        .and_then(|r| r.to_f64())
        .or_else(|| v.as_irational().and_then(|r| r.to_f64()))
        .or_else(|| v.as_f64())
        .or_else(|| v.as_u32().map(f64::from))
        .or_else(|| v.as_u16().map(f64::from))
        .or_else(|| v.as_u64().map(|n| n as f64))
        .or_else(|| v.as_i32().map(f64::from))
}

fn when(v: Option<&EntryValue>) -> Option<String> {
    use nom_exif::ExifDateTime;
    let s = match v?.as_datetime()? {
        ExifDateTime::Aware(d) => d.format("%Y-%m-%d %H:%M:%S").to_string(),
        ExifDateTime::Naive(d) => d.format("%Y-%m-%d %H:%M:%S").to_string(),
    };
    // MP4 counts from 1904: a file without a date says 1904-01-01
    s.get(..4).and_then(|y| y.parse::<u32>().ok()).is_some_and(|y| y > 1970).then_some(s)
}

fn gps(g: &GPSInfo) -> Option<Value> {
    let deg = |l: &nom_exif::LatLng| Some(l.degrees.to_f64()? + l.minutes.to_f64()? / 60.0 + l.seconds.to_f64()? / 3600.0);
    let lat = deg(&g.latitude)? * g.latitude_ref.sign();
    let lon = deg(&g.longitude)? * g.longitude_ref.sign();
    // 0,0 is what a phone writes when it had no fix
    (lat.is_finite() && lon.is_finite() && (lat != 0.0 || lon != 0.0)).then(|| json!([round(lat, 6), round(lon, 6)]))
}

fn round(v: f64, digits: i32) -> f64 {
    let p = 10f64.powi(digits);
    (v * p).round() / p
}

fn put(out: &mut Map<String, Value>, key: &str, v: Option<impl Into<Value>>) {
    if let Some(v) = v {
        out.insert(key.into(), v.into());
    }
}

fn exif(e: &nom_exif::Exif, out: &mut Map<String, Value>) {
    let make = text(e.get(ExifTag::Make));
    let model = text(e.get(ExifTag::Model));
    put(out, "camera", camera(make, model));
    put(out, "lens", text(e.get(ExifTag::LensModel)));
    put(out, "focal", number(e.get(ExifTag::FocalLength)).map(|f| round(f, 1)));
    put(out, "focal35", number(e.get(ExifTag::FocalLengthIn35mmFilm)).filter(|f| *f > 0.0));
    put(out, "aperture", number(e.get(ExifTag::FNumber)).filter(|f| *f > 0.0).map(|f| round(f, 1)));
    put(out, "exposure", number(e.get(ExifTag::ExposureTime)).filter(|f| *f > 0.0));
    put(out, "iso", number(e.get(ExifTag::ISOSpeedRatings)).filter(|f| *f > 0.0));
    put(out, "taken", when(e.get(ExifTag::DateTimeOriginal)));
    let w = number(e.get(ExifTag::ExifImageWidth)).or_else(|| number(e.get(ExifTag::ImageWidth)));
    let h = number(e.get(ExifTag::ExifImageHeight)).or_else(|| number(e.get(ExifTag::ImageHeight)));
    if let (Some(w), Some(h)) = (w, h)
        && w > 0.0
        && h > 0.0
    {
        // 5..8: the camera was turned, the picture shows the other way round
        let turned = number(e.get(ExifTag::Orientation)).is_some_and(|o| (5.0..=8.0).contains(&o));
        let (w, h) = if turned { (h, w) } else { (w, h) };
        out.insert("width".into(), json!(w as u64));
        out.insert("height".into(), json!(h as u64));
    }
    put(out, "gps", e.gps_info().and_then(gps));
}

/// "Apple iPhone 13" rather than "Apple Apple iPhone 13"
fn camera(make: Option<String>, model: Option<String>) -> Option<String> {
    match (make, model) {
        (Some(make), Some(model)) if model.to_lowercase().starts_with(&make.to_lowercase().split_whitespace().next().unwrap_or("").to_string()) => Some(model),
        (Some(make), Some(model)) => Some(format!("{make} {model}")),
        (make, model) => make.or(model),
    }
}

fn track_info(t: &nom_exif::TrackInfo, out: &mut Map<String, Value>) {
    put(out, "camera", camera(text(t.get(TrackInfoTag::Make)), text(t.get(TrackInfoTag::Model))));
    put(out, "taken", when(t.get(TrackInfoTag::CreateDate)));
    put(out, "duration", number(t.get(TrackInfoTag::DurationMs)).filter(|d| *d > 0.0).map(|d| round(d / 1000.0, 2)));
    if let (Some(w), Some(h)) = (number(t.get(TrackInfoTag::Width)), number(t.get(TrackInfoTag::Height)))
        && w > 0.0
        && h > 0.0
    {
        out.insert("width".into(), json!(w as u64));
        out.insert("height".into(), json!(h as u64));
    }
    put(out, "gps", t.gps_info().and_then(gps));
}

/// ffmpeg's description of the input (it complains there is no output: fine).
fn ffmpeg(path: &Path) -> Option<String> {
    if !Path::new(FFMPEG).exists() {
        return None;
    }
    // "file:" keeps a name that starts with "-" or holds ":" from being read as anything else
    let mut input = std::ffi::OsString::from("file:");
    input.push(path.as_os_str());
    let mut child = Command::new(FFMPEG)
        .args(["-hide_banner", "-nostdin", "-i"])
        .arg(input)
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let mut err = child.stderr.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = err.by_ref().take(256 * 1024).read_to_end(&mut s);
        s
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < FFMPEG_WAIT => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    reader.join().ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// The lines that matter in what ffmpeg prints about an input:
///   Duration: 00:00:54.73, start: 0.000000, bitrate: 2752 kb/s
///   Stream #0:0(eng): Video: h264 (avc1 / 0x31637661), yuv420p(tv, bt2020nc/bt2020/smpte2084), 1280x720, 2494 kb/s, 15 fps, …
///   Stream #0:1(eng): Audio: aac (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 256 kb/s (default)
fn parse_ffmpeg(text: &str) -> Map<String, Value> {
    let mut out = Map::new();
    let mut subtitles = 0u32;
    let mut audio_tracks = 0u32;
    for line in text.lines().map(str::trim) {
        if let Some(rest) = line.strip_prefix("Duration:") {
            let mut parts = rest.split(',').map(str::trim);
            if let Some(d) = parts.next().and_then(clock) {
                out.insert("duration".into(), json!(round(d, 2)));
            }
            for p in parts {
                if let Some(b) = p.strip_prefix("bitrate:").and_then(|b| b.trim().strip_suffix("kb/s")).and_then(|b| b.trim().parse::<u64>().ok()) {
                    out.insert("bitrate".into(), json!(b));
                }
            }
        } else if line.starts_with("Stream #") {
            let Some((_, desc)) = line.split_once("): ").or_else(|| line.split_once(": ")) else { continue };
            let Some((kind, rest)) = desc.split_once(": ") else { continue };
            let fields: Vec<&str> = split_fields(rest);
            let codec = fields.first().and_then(|c| c.split_whitespace().next()).unwrap_or("").to_string();
            match kind {
                "Video" if !out.contains_key("video") => {
                    // a cover picture in a song is a "video" stream too
                    if line.contains("(attached pic)") {
                        continue;
                    }
                    let mut v = Map::new();
                    v.insert("codec".into(), json!(codec));
                    for f in &fields {
                        if let Some((w, h)) = f.split_whitespace().next().and_then(|s| s.split_once('x')).and_then(|(w, h)| Some((w.parse::<u64>().ok()?, h.parse::<u64>().ok()?))) {
                            out.insert("width".into(), json!(w));
                            out.insert("height".into(), json!(h));
                        }
                        if let Some(fps) = f.strip_suffix(" fps").and_then(|n| n.trim().parse::<f64>().ok()) {
                            v.insert("fps".into(), json!(round(fps, 3)));
                        }
                    }
                    if rest.contains("smpte2084") || rest.contains("arib-std-b67") {
                        v.insert("hdr".into(), json!(if rest.contains("smpte2084") { "HDR10" } else { "HLG" }));
                    }
                    out.insert("video".into(), Value::Object(v));
                }
                "Audio" => {
                    audio_tracks += 1;
                    if out.contains_key("audio") {
                        continue;
                    }
                    let mut a = Map::new();
                    a.insert("codec".into(), json!(codec));
                    for f in &fields {
                        if let Some(hz) = f.strip_suffix(" Hz").and_then(|n| n.trim().parse::<u64>().ok()) {
                            a.insert("rate".into(), json!(hz));
                        } else if ["mono", "stereo"].contains(f) || f.contains("5.1") || f.contains("7.1") || f.ends_with(" channels") {
                            a.insert("channels".into(), json!(f));
                        }
                    }
                    out.insert("audio".into(), Value::Object(a));
                }
                "Subtitle" => subtitles += 1,
                _ => {}
            }
        }
    }
    if audio_tracks > 1 {
        out.insert("audioTracks".into(), json!(audio_tracks));
    }
    if subtitles > 0 {
        out.insert("subtitles".into(), json!(subtitles));
    }
    out
}

/// "a, b(c, d), e" → ["a", "b(c, d)", "e"]: commas inside brackets stay.
fn split_fields(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let (mut depth, mut start) = (0i32, 0);
    for (i, ch) in s.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                out.push(s[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(s[start..].trim());
    out
}

/// "01:02:03.50" → 3723.5
fn clock(s: &str) -> Option<f64> {
    let mut parts = s.split(':');
    let (h, m, sec) = (parts.next()?.parse::<f64>().ok()?, parts.next()?.parse::<f64>().ok()?, parts.next()?.parse::<f64>().ok()?);
    Some(h * 3600.0 + m * 60.0 + sec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_ffmpeg_prints() {
        let text = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'file:/x.mp4':
  Duration: 00:00:54.73, start: 0.000000, bitrate: 2752 kb/s
    Stream #0:0(eng): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160, 2494 kb/s, 29.97 fps, 15 tbr (default)
    Stream #0:1(eng): Audio: aac (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 256 kb/s (default)
    Stream #0:2(ita): Audio: ac3, 48000 Hz, 5.1(side), fltp, 384 kb/s
    Stream #0:3(ita): Subtitle: subrip
At least one output file must be specified";
        let m = parse_ffmpeg(text);
        assert_eq!(m["duration"], json!(54.73));
        assert_eq!(m["bitrate"], json!(2752));
        assert_eq!(m["width"], json!(3840));
        assert_eq!(m["height"], json!(2160));
        assert_eq!(m["video"], json!({"codec": "hevc", "fps": 29.97, "hdr": "HDR10"}));
        assert_eq!(m["audio"], json!({"codec": "aac", "rate": 48000, "channels": "stereo"}));
        assert_eq!(m["audioTracks"], json!(2));
        assert_eq!(m["subtitles"], json!(1));
    }

    #[test]
    fn a_song_with_its_cover() {
        let text = "  Duration: 00:03:21.05, start: 0.025057, bitrate: 320 kb/s
    Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s
    Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 500x500 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn (attached pic)";
        let m = parse_ffmpeg(text);
        assert!(m.get("video").is_none() && m.get("width").is_none());
        assert_eq!(m["audio"]["codec"], json!("mp3"));
        assert_eq!(m["duration"], json!(201.05));
    }

    #[test]
    fn camera_name_without_the_make_twice() {
        assert_eq!(camera(Some("Apple".into()), Some("iPhone 13".into())).as_deref(), Some("Apple iPhone 13"));
        assert_eq!(camera(Some("Canon".into()), Some("Canon EOS R6".into())).as_deref(), Some("Canon EOS R6"));
        assert_eq!(camera(Some("NIKON CORPORATION".into()), Some("NIKON D750".into())).as_deref(), Some("NIKON D750"));
        assert_eq!(camera(None, Some("X".into())).as_deref(), Some("X"));
    }
}
