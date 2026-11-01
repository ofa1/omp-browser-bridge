use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
pub mod unix;
#[cfg(unix)]
pub use unix::*;

#[cfg(windows)]
pub mod windows;
#[cfg(windows)]
pub use windows::*;

pub fn get_bridge_dir() -> PathBuf {
    if let Ok(val) = std::env::var("OMP_FIREFOX_DIR") {
        if !val.trim().is_empty() {
            return PathBuf::from(val);
        }
    }
    let home = dirs_home().unwrap_or_else(|| PathBuf::from("."));
    home.join(".omp").join("firefox")
}

pub fn dirs_home() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
}

pub fn clean_stale_endpoints(dir: &Path) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = match name.to_str() {
            Some(s) => s,
            None => continue,
        };
        if name_str == "host-version.json" {
            continue;
        }

        if let Some((pid_str, ext)) = parse_endpoint_filename(name_str) {
            if let Ok(pid) = pid_str.parse::<u32>() {
                if !is_process_alive(pid) {
                    let path = dir.join(format!("{}.{}", pid, ext));
                    let _ = fs::remove_file(path);
                }
            }
        }
    }
}

fn parse_endpoint_filename(name: &str) -> Option<(&str, &str)> {
    let parts: Vec<&str> = name.split('.').collect();
    if parts.len() == 2 && (parts[1] == "sock" || parts[1] == "json") && parts[0].chars().all(|c| c.is_ascii_digit()) {
        Some((parts[0], parts[1]))
    } else {
        None
    }
}

pub fn write_metadata_atomic(
    dir: &Path,
    pid: u32,
    endpoint: &str,
    browser_session: Option<&str>,
) -> std::io::Result<()> {
    let meta_path = dir.join(format!("{}.json", pid));
    let tmp_path = dir.join(format!("{}.json.tmp", pid));

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let session_val = match browser_session {
        Some(s) => format!(r#""{}""#, s),
        None => "null".to_string(),
    };

    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    };

    let content = format!(
        r#"{{
  "pid": {},
  "endpoint": "{}",
  "platform": "{}",
  "created": {},
  "version": 1,
  "hostImpl": "rust",
  "browserSession": {}
}}
"#,
        pid,
        endpoint.replace('\\', "\\\\"),
        platform,
        now_ms,
        session_val
    );

    fs::write(&tmp_path, content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp_path, &meta_path)?;
    Ok(())
}

pub fn remove_metadata(dir: &Path, pid: u32) {
    let meta_path = dir.join(format!("{}.json", pid));
    let _ = fs::remove_file(meta_path);
}
