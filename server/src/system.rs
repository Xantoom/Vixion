//! What the operating system knows: free disk space, memory, and where a folder really lives.

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

/// Memory as the kernel counts it, in bytes. The container's figure (what `docker stats` and
/// monitoring tools show) includes the disk cache: recordings written and read stay in it until the
/// kernel needs the room.
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct Memory {
    /// The program's own memory: what it allocated.
    pub process: u64,
    /// Files the program has mapped (its own code, mostly).
    pub mapped: u64,
    /// The cgroup's total, cache included; None outside a cgroup v2.
    pub cgroup: Option<u64>,
    /// The cgroup's disk cache, recently used part (counted by `docker stats`) and the rest.
    pub cache_active: Option<u64>,
    pub cache_inactive: Option<u64>,
}

/// A `key value` line's value, from a `/proc` or cgroup file.
fn field(text: &str, key: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let rest = line.strip_prefix(key)?;
        let rest = rest.strip_prefix(':').unwrap_or(rest);
        rest.split_whitespace().next()?.parse().ok()
    })
}

pub fn memory() -> Memory {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let kib = |key| field(&status, key).map_or(0, |value| value * 1024);
    // cgroup v2: one line, `0::/path`; `/` in a container with its own cgroup namespace.
    let cgroup = std::fs::read_to_string("/proc/self/cgroup")
        .ok()
        .and_then(|text| text.lines().find_map(|line| line.strip_prefix("0::").map(str::to_owned)))
        .map(|path| Path::new("/sys/fs/cgroup").join(path.trim_start_matches('/')));
    let stat = cgroup.as_ref().and_then(|dir| std::fs::read_to_string(dir.join("memory.stat")).ok());
    let current = cgroup
        .as_ref()
        .and_then(|dir| std::fs::read_to_string(dir.join("memory.current")).ok())
        .and_then(|text| text.trim().parse().ok());
    Memory {
        process: kib("RssAnon"),
        mapped: kib("RssFile") + kib("RssShmem"),
        cgroup: current,
        cache_active: stat.as_deref().and_then(|stat| field(stat, "active_file")),
        cache_inactive: stat.as_deref().and_then(|stat| field(stat, "inactive_file")),
    }
}

/// Tells the kernel a file's bytes from `offset` (`length` of them, 0 for the rest) won't be read
/// again soon, so that its cache can go now rather than when memory runs short. Only pages already
/// on disk go: those still being written stay until written.
#[cfg(target_os = "linux")]
pub fn drop_cache(file: &std::fs::File, offset: u64, length: u64) {
    use std::os::fd::AsRawFd as _;
    let (Ok(offset), Ok(length)) = (libc::off_t::try_from(offset), libc::off_t::try_from(length)) else { return };
    // SAFETY: the descriptor is open for as long as `file` lives; the call only advises the kernel.
    unsafe { libc::posix_fadvise(file.as_raw_fd(), offset, length, libc::POSIX_FADV_DONTNEED) };
}

#[cfg(not(target_os = "linux"))]
pub fn drop_cache(_file: &std::fs::File, _offset: u64, _length: u64) {}

/// Starts writing a file's range to disk without waiting, so that a later `drop_cache` finds it
/// clean and can let it go.
#[cfg(target_os = "linux")]
pub fn start_writeback(file: &std::fs::File, offset: u64, length: u64) {
    use std::os::fd::AsRawFd as _;
    let (Ok(offset), Ok(length)) = (libc::off64_t::try_from(offset), libc::off64_t::try_from(length)) else { return };
    // SAFETY: as above; SYNC_FILE_RANGE_WRITE only queues the writing.
    unsafe { libc::sync_file_range(file.as_raw_fd(), offset, length, libc::SYNC_FILE_RANGE_WRITE) };
}

#[cfg(not(target_os = "linux"))]
pub fn start_writeback(_file: &std::fs::File, _offset: u64, _length: u64) {}

/// Has the kernel probe an idle connection: a viewer whose network vanished (a phone out of
/// reach) never closes it, and without probes it would hold its memory until the server restarts.
/// Dead after about two minutes of silence.
pub fn keep_alive(tcp: &tokio::net::TcpStream) {
    let probes = socket2::TcpKeepalive::new()
        .with_time(std::time::Duration::from_secs(60))
        .with_interval(std::time::Duration::from_secs(10))
        .with_retries(6);
    let _ = socket2::SockRef::from(tcp).set_tcp_keepalive(&probes);
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

    #[test]
    fn reads_kernel_fields() {
        let status = "Name:\tvixion\nRssAnon:\t   12345 kB\nRssFile:\t    678 kB\n";
        assert_eq!(field(status, "RssAnon"), Some(12345));
        assert_eq!(field(status, "RssFile"), Some(678));
        let stat = "anon 100\nfile 900\nactive_file 300\ninactive_file 600\n";
        assert_eq!(field(stat, "active_file"), Some(300));
        assert_eq!(field(stat, "file"), Some(900));
        assert_eq!(field(stat, "missing"), None);
    }
}
