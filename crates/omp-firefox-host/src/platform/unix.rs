use std::fs;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use tokio::net::{UnixListener, UnixStream};

pub fn ensure_secure_bridge_dir(target_dir: &Path) -> std::io::Result<()> {
    if target_dir.exists() {
        let meta = fs::symlink_metadata(target_dir)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!("Bridge directory {:?} is not a real directory or is a symlink", target_dir),
            ));
        }

        let current_uid = unsafe { libc::getuid() };
        if meta.uid() != current_uid {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "Bridge directory {:?} is not owned by current user (owner UID: {}, expected: {})",
                    target_dir,
                    meta.uid(),
                    current_uid
                ),
            ));
        }

        let mode = meta.mode();
        if (mode & 0o077) != 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "Bridge directory {:?} has insecure permissions ({:o}). Must not allow group/other access.",
                    target_dir,
                    mode & 0o777
                ),
            ));
        }
    } else {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        builder.mode(0o700);
        builder.create(target_dir)?;
    }
    Ok(())
}

pub fn is_process_alive(pid: u32) -> bool {
    let res = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if res == 0 {
        return true;
    }
    let err = std::io::Error::last_os_error();
    // EPERM means process exists but we lack permission to signal it
    err.raw_os_error() == Some(libc::EPERM)
}

pub struct ServerListener {
    pub listener: UnixListener,
    pub sock_path: PathBuf,
}

pub async fn bind_ipc_listener(dir: &Path, pid: u32) -> std::io::Result<ServerListener> {
    let sock_path = dir.join(format!("{}.sock", pid));
    // Remove stale socket if present
    let _ = fs::remove_file(&sock_path);

    let listener = UnixListener::bind(&sock_path)?;
    let _ = fs::set_permissions(&sock_path, fs::Permissions::from_mode(0o600));

    Ok(ServerListener { listener, sock_path })
}

pub fn verify_client_peer(stream: &UnixStream) -> bool {
    match stream.peer_cred() {
        Ok(cred) => {
            let current_uid = unsafe { libc::getuid() };
            cred.uid() == current_uid
        }
        Err(_) => false,
    }
}
