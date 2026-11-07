//! Names of the temporary files that SynoFile writes next to a target
//! (uploads, copies, extractions): `.{name}.{tag}`, kept within the 255
//! bytes a file name may have on the NAS file systems.

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::{OsStrExt, OsStringExt};

/// Longest file name the NAS file systems (ext4, btrfs) accept, in bytes.
const NAME_MAX: usize = 255;

/// Temporary name for `name`: `.{name}.{tag}`, with `name` shortened (on a
/// UTF-8 character boundary) so the whole stays within 255 bytes.
pub fn part_name(name: &str, tag: &str) -> String {
    let bytes = part_bytes(name.as_bytes(), tag.as_bytes());
    // only whole characters are cut away, so the result is still UTF-8
    String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// Same as [`part_name`] for names that may not be UTF-8.
pub fn part_os(name: &OsStr, tag: &str) -> OsString {
    OsString::from_vec(part_bytes(name.as_bytes(), tag.as_bytes()))
}

fn part_bytes(name: &[u8], tag: &[u8]) -> Vec<u8> {
    // the two dots plus the tag; the name gets what is left
    let room = NAME_MAX.saturating_sub(tag.len() + 2);
    let mut cut = name.len().min(room);
    // step back over UTF-8 continuation bytes so no character is split
    while cut > 0 && cut < name.len() && (name[cut] & 0xc0) == 0x80 {
        cut -= 1;
    }
    let mut out = Vec::with_capacity(cut + tag.len() + 2);
    out.push(b'.');
    out.extend_from_slice(&name[..cut]);
    out.push(b'.');
    out.extend_from_slice(tag);
    out
}

/// How long an upload's hidden file may lie untouched before it counts
/// as abandoned (the browser closed halfway).
pub const ABANDONED_AFTER: std::time::Duration = std::time::Duration::from_secs(24 * 3600);

/// Whether a hidden upload file was abandoned, as of `now`. By ctime, not
/// mtime: the file gets the original's time, often years old, just before
/// its rename, and every write moves ctime on.
pub fn abandoned(meta: &std::fs::Metadata, now: std::time::SystemTime) -> bool {
    use std::os::unix::fs::MetadataExt;
    let changed = std::time::UNIX_EPOCH + std::time::Duration::from_secs(u64::try_from(meta.ctime()).unwrap_or(0));
    now.duration_since(changed).is_ok_and(|age| age > ABANDONED_AFTER)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_names_are_kept_whole() {
        assert_eq!(part_name("a.txt", "synofile-part"), ".a.txt.synofile-part");
        assert_eq!(part_name("a.txt", "abc12345.synofile-upload"), ".a.txt.abc12345.synofile-upload");
        assert_eq!(part_os(OsStr::new("b"), "x"), OsString::from(".b.x"));
    }

    #[test]
    fn long_names_stay_within_the_limit() {
        let tag = "0123456789abcdef0123456789abcdef.synofile-upload";
        for len in [200, 254, 255, 300, 1000] {
            let name = "a".repeat(len);
            let part = part_name(&name, tag);
            assert!(part.len() <= NAME_MAX, "{len}: {}", part.len());
            assert!(part.ends_with(&format!(".{tag}")));
        }
        // exactly at the limit when the name is long enough
        assert_eq!(part_name(&"a".repeat(300), tag).len(), NAME_MAX);
    }

    #[test]
    fn multibyte_names_are_cut_on_character_boundaries() {
        for unit in ["è", "日", "😀"] {
            for count in 60..130 {
                let name = unit.repeat(count);
                let part = part_name(&name, "synofile-part");
                assert!(part.len() <= NAME_MAX);
                let kept = &part[1..part.len() - ".synofile-part".len()];
                assert!(name.starts_with(kept));
                assert_eq!(kept.len() % unit.len(), 0);
                // the same through the byte version
                assert_eq!(part_os(OsStr::new(&name), "synofile-part").as_bytes(), part.as_bytes());
            }
        }
    }

    #[test]
    fn non_utf8_names_are_kept_as_bytes() {
        let name = OsStr::from_bytes(b"caf\xe9.txt");
        assert_eq!(part_os(name, "t").as_bytes(), b".caf\xe9.txt.t");
    }
}
