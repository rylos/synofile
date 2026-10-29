//! The capabilities the package needs, and how they get there.
//!
//! Every file operation runs as the DSM user who asked for it, so the
//! kernel applies that user's permissions and Synology ACLs. Becoming that
//! user takes CAP_SETUID and CAP_SETGID, nothing more: the package never
//! reads or writes a file with privileges of its own.
//!
//! DSM 7 refuses the `capabilities` field of conf/privilege in third-party
//! packages ("invalid package privilege content", error 319), so the
//! package installs unprivileged and `synofile setup`, run once as root,
//! writes the file capability itself. Reinstalling or upgrading the package
//! replaces the binary and drops it: setup has to run again.

use std::ffi::CString;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;

const CAP_SETGID: u32 = 6;
const CAP_SETUID: u32 = 7;

const VFS_CAP_REVISION_2: u32 = 0x0200_0000;
const VFS_CAP_FLAGS_EFFECTIVE: u32 = 0x1;

fn mask() -> u64 {
    (1 << CAP_SETUID) | (1 << CAP_SETGID)
}

fn status_field(name: &str) -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status
        .lines()
        .find_map(|line| line.strip_prefix(name))
        .and_then(|hex| u64::from_str_radix(hex.trim(), 16).ok())
}

/// Whether this process can become another user right now.
pub fn effective() -> bool {
    status_field("CapEff:").is_some_and(|eff| eff & mask() == mask())
}

/// Whether this process holds no capability at all, in any set.
pub fn none_left() -> bool {
    ["CapEff:", "CapPrm:", "CapInh:"].iter().all(|f| status_field(f) == Some(0))
}

/// The security.capability xattr value: revision 2, effective, permitted
/// set = our two capabilities, nothing inheritable.
pub fn xattr_value() -> [u8; 20] {
    let permitted = mask();
    let words = [
        VFS_CAP_REVISION_2 | VFS_CAP_FLAGS_EFFECTIVE,
        permitted as u32,
        0,
        (permitted >> 32) as u32,
        0,
    ];
    let mut value = [0u8; 20];
    for (chunk, word) in value.as_chunks_mut::<4>().0.iter_mut().zip(words) {
        chunk.copy_from_slice(&word.to_le_bytes());
    }
    value
}

/// Whether `binary` carries the file capabilities written by `install`.
pub fn on_file(binary: &Path) -> bool {
    let Ok(path) = CString::new(binary.as_os_str().as_bytes()) else {
        return false;
    };
    let mut value = [0u8; 20];
    // SAFETY: valid C strings and a buffer of the stated length
    let len = unsafe {
        libc::getxattr(path.as_ptr(), c"security.capability".as_ptr(), value.as_mut_ptr().cast(), value.len())
    };
    len == 20 && value == xattr_value()
}

/// Gives `binary` the file capabilities. Needs root.
///
/// The package user must not be able to change what runs with privileges:
/// neither this binary, which root runs for setup and which can become any
/// user, nor the worker, which runs as the DSM user who started a transfer.
/// Both, and the directories up to the package's target, become root's
/// first (chown would drop the capability, so it comes last). This binary
/// stays executable by the package's group only.
pub fn install(binary: &Path) -> io::Result<()> {
    if let Some((target, bin_dir)) = package_dirs(binary) {
        let group = std::fs::metadata(binary)?.gid();
        for dir in [target, bin_dir] {
            std::os::unix::fs::lchown(dir, Some(0), Some(0))?;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755))?;
        }
        let worker = bin_dir.join("synofile-worker");
        if worker.exists() {
            std::os::unix::fs::lchown(&worker, Some(0), Some(0))?;
            std::fs::set_permissions(&worker, std::fs::Permissions::from_mode(0o755))?;
        }
        std::os::unix::fs::lchown(binary, Some(0), Some(group))?;
        std::fs::set_permissions(binary, std::fs::Permissions::from_mode(0o750))?;
    }
    let path = CString::new(binary.as_os_str().as_bytes()).map_err(io::Error::other)?;
    let value = xattr_value();
    // SAFETY: valid C strings and a buffer of the stated length
    let rc = unsafe {
        libc::setxattr(path.as_ptr(), c"security.capability".as_ptr(), value.as_ptr().cast(), value.len(), 0)
    };
    if rc < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Empties every capability set of the calling thread. Changing between
/// two non-root uids keeps the permitted set, so dropping to a user does
/// not do this by itself.
pub fn clear() -> io::Result<()> {
    #[repr(C)]
    struct Header {
        version: u32,
        pid: i32,
    }
    #[repr(C)]
    struct Data {
        effective: u32,
        permitted: u32,
        inheritable: u32,
    }
    const LINUX_CAPABILITY_VERSION_3: u32 = 0x2008_0522;
    let header = Header { version: LINUX_CAPABILITY_VERSION_3, pid: 0 };
    let data = [Data { effective: 0, permitted: 0, inheritable: 0 }, Data { effective: 0, permitted: 0, inheritable: 0 }];
    // SAFETY: the kernel reads a v3 header and two data structs
    let rc = unsafe { libc::syscall(libc::SYS_capset, &header as *const Header, data.as_ptr()) };
    if rc < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// `<target>/bin/synofile` of the installed package, as (target, bin);
/// None for a development build, whose directories stay as they are.
fn package_dirs(binary: &Path) -> Option<(&Path, &Path)> {
    let bin_dir = binary.parent()?;
    let target = bin_dir.parent()?;
    (bin_dir.file_name()? == "bin" && target.file_name()? == "synofile").then_some((target, bin_dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xattr_matches_setcap() {
        // `setcap cap_setuid,cap_setgid+ep` writes exactly this
        assert_eq!(xattr_value(), [0x01, 0, 0, 0x02, 0xc0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn hardens_only_the_installed_package() {
        let installed = Path::new("/volume2/@appstore/synofile/bin/synofile");
        assert_eq!(
            package_dirs(installed),
            Some((Path::new("/volume2/@appstore/synofile"), Path::new("/volume2/@appstore/synofile/bin")))
        );
        assert_eq!(package_dirs(Path::new("/home/me/synofile/target/debug/synofile")), None);
    }
}
