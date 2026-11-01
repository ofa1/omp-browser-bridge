use std::fs;
use std::path::{Path, PathBuf};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

pub fn ensure_secure_bridge_dir(target_dir: &Path) -> std::io::Result<()> {
    if !target_dir.exists() {
        fs::create_dir_all(target_dir)?;
    }
    Ok(())
}

pub fn is_process_alive(pid: u32) -> bool {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code: u32 = 0;
        let success = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        success != 0 && exit_code == STILL_ACTIVE as u32
    }
}

pub struct ServerListener {
    pub pipe_name: String,
    pub server: NamedPipeServer,
    pub options: ServerOptions,
}

pub async fn bind_ipc_listener(_dir: &Path, _pid: u32) -> std::io::Result<ServerListener> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let pipe_name = format!(r"\\.\pipe\omp-firefox-{:x}", now);

    let mut options = ServerOptions::new();
    options.first_pipe_instance(true);
    options.reject_remote_clients(true);

    let server = options.create(&pipe_name)?;

    Ok(ServerListener {
        pipe_name,
        server,
        options,
    })
}
