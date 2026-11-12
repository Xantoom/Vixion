//! What the operating system knows: free disk space and memory used by the process.

use std::path::Path;

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

/// Resident memory of this process, in bytes (Linux only).
pub fn memory_used() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|line| line.starts_with("VmRSS:"))?;
    let kilobytes: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kilobytes * 1024)
}
