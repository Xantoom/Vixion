//! What the operating system knows: free disk space, and where a folder really lives.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct DiskSpace {
    pub total: u64,
    pub free: u64,
}

/// Space on the file system holding `path`.
#[cfg(unix)]
pub fn disk_space(path: &Path) -> Option<DiskSpace> {
    use std::os::unix::ffi::OsStrExt as _;

    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
    // SAFETY: `path` is a valid NUL-terminated string and `stats` points to writable memory of
    // the right type; statvfs only writes into it.
    let result = unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) };
    if result != 0 {
        return None;
    }
    // SAFETY: statvfs returned 0, so it filled the structure.
    let stats = unsafe { stats.assume_init() };
    let block = stats.f_frsize.max(1);
    Some(DiskSpace { total: stats.f_blocks * block, free: stats.f_bavail * block })
}

#[cfg(not(unix))]
pub fn disk_space(_path: &Path) -> Option<DiskSpace> {
    None
}

/// One of Vixion's folders, as the administration shows it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Folder {
    /// The path Vixion uses.
    pub path: String,
    /// Where it comes from when it is mounted into a container: a host folder, or a Docker
    /// volume's folder.
    pub source: Option<String>,
    /// In a container but not mounted: its contents go with the container.
    pub unmapped: bool,
    pub disk: DiskSpace,
}

pub fn folder(path: &Path) -> Folder {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mounts = std::fs::read_to_string("/proc/self/mountinfo").unwrap_or_default();
    let in_container = Path::new("/.dockerenv").exists() || Path::new("/run/.containerenv").exists();
    let (source, unmapped) = match mount_of(&mounts, &resolved) {
        Some(mount) if in_container && mount.point != Path::new("/") => (Some(mount.source_of(&resolved)), false),
        _ => (None, in_container),
    };
    Folder { path: path.display().to_string(), source, unmapped, disk: disk_space(path).unwrap_or_default() }
}

struct Mount {
    /// The folder of the mounted file system that appears at `point`.
    root: String,
    point: PathBuf,
}

impl Mount {
    /// `path`'s place in the mounted file system: for a bind mount, the host folder.
    fn source_of(&self, path: &Path) -> String {
        match path.strip_prefix(&self.point) {
            Ok(rest) if !rest.as_os_str().is_empty() => Path::new(&self.root).join(rest).display().to_string(),
            _ => self.root.clone(),
        }
    }
}

/// The mount holding `path`: the one with the longest mount point above it.
fn mount_of(mountinfo: &str, path: &Path) -> Option<Mount> {
    mountinfo
        .lines()
        .filter_map(|line| {
            // id parent major:minor root mount-point options… - type source super-options
            let mut fields = line.split(' ');
            let root = unescape(fields.nth(3)?);
            let point = PathBuf::from(unescape(fields.next()?));
            Some(Mount { root, point })
        })
        .filter(|mount| path.starts_with(&mount.point))
        .max_by_key(|mount| mount.point.components().count())
}

/// Mount tables write spaces, tabs, newlines and backslashes as octal escapes.
fn unescape(field: &str) -> String {
    let mut out = String::with_capacity(field.len());
    let mut rest = field;
    while let Some(at) = rest.find('\\') {
        out.push_str(&rest[..at]);
        let code = rest.get(at + 1..at + 4).and_then(|digits| u8::from_str_radix(digits, 8).ok());
        match code {
            Some(byte) => {
                out.push(char::from(byte));
                rest = &rest[at + 4..];
            }
            None => {
                out.push('\\');
                rest = &rest[at + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const MOUNTINFO: &str = "\
600 500 0:52 / / rw,relatime - overlay overlay rw,lowerdir=/x
601 600 8:1 /srv/vixion/config /config rw,relatime - ext4 /dev/sda1 rw
602 600 8:2 /var/lib/docker/volumes/recordings/_data /recordings rw - ext4 /dev/sdb1 rw
603 600 8:1 /home/me/my\\040videos /media rw - ext4 /dev/sda1 rw";

    #[test]
    fn finds_where_a_folder_comes_from() {
        let config = mount_of(MOUNTINFO, Path::new("/config")).unwrap();
        assert_eq!(config.source_of(Path::new("/config")), "/srv/vixion/config");
        let nested = mount_of(MOUNTINFO, Path::new("/recordings/streams")).unwrap();
        assert_eq!(
            nested.source_of(Path::new("/recordings/streams")),
            "/var/lib/docker/volumes/recordings/_data/streams"
        );
        let spaced = mount_of(MOUNTINFO, Path::new("/media")).unwrap();
        assert_eq!(spaced.source_of(Path::new("/media")), "/home/me/my videos");
        // Not mounted: it lives in the container's own layer.
        assert_eq!(mount_of(MOUNTINFO, Path::new("/tmp/x")).unwrap().point, Path::new("/"));
    }
}
