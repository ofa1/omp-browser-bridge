use crate::platform::{dirs_home, ensure_secure_bridge_dir, get_bridge_dir};
use crate::protocol::HOST_VERSION;
use std::fs;
#[allow(unused_imports)]
use std::path::{Path, PathBuf};

pub const EXTENSION_ID: &str = "omp-firefox-bridge@omairahmed";

pub enum CliCommand {
    RunNativeHost,
    Install,
    Uninstall,
    Doctor,
    Version,
    Help,
}

pub fn parse_args() -> CliCommand {
    let args: Vec<String> = std::env::args().collect();
    if args.len() <= 1 {
        return CliCommand::RunNativeHost;
    }

    match args[1].as_str() {
        "install" => CliCommand::Install,
        "uninstall" => CliCommand::Uninstall,
        "doctor" => CliCommand::Doctor,
        "-V" | "--version" | "version" => CliCommand::Version,
        "-h" | "--help" | "help" => CliCommand::Help,
        // Firefox launches native messaging hosts with [path_to_manifest, extension_id]
        _ => CliCommand::RunNativeHost,
    }
}

pub fn print_help() {
    println!("omp-firefox-host {}", HOST_VERSION);
    println!("Native messaging host for the omp Firefox browser bridge.\n");
    println!("USAGE:");
    println!("  omp-firefox-host [COMMAND]\n");
    println!("COMMANDS:");
    println!("  install     Register this binary with Firefox as the native messaging host");
    println!("  uninstall   Unregister the native messaging host and remove manifests");
    println!("  doctor      Check configuration, manifests, and bridge permissions");
    println!("  version     Print version information");
    println!("  help        Print this help message\n");
    println!("When invoked without arguments, runs as the native messaging host for Firefox.");
}

pub fn run_install() -> Result<(), Box<dyn std::error::Error>> {
    let exe_path = std::env::current_exe()?;
    let canonical_exe = fs::canonicalize(&exe_path).unwrap_or(exe_path);
    let exe_str = canonical_exe.to_string_lossy();

    println!("Registering omp-firefox-host with Firefox...");
    println!("  Binary path: {}", exe_str);

    let manifest_paths = get_manifest_target_paths();
    let manifest_content = format!(
        r#"{{
  "name": "omp_firefox",
  "description": "omp coding agent Firefox native messaging bridge",
  "path": "{}",
  "type": "stdio",
  "allowed_extensions": [
    "{}"
  ]
}}
"#,
        exe_str.replace('\\', "\\\\"),
        EXTENSION_ID
    );

    for path in &manifest_paths {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, &manifest_content)?;
        println!("  Wrote manifest: {}", path.display());
    }

    #[cfg(windows)]
    {
        if let Some(primary) = manifest_paths.first() {
            register_windows_registry(primary)?;
            println!("  Registered HKCU\\Software\\Mozilla\\NativeMessagingHosts\\omp_firefox");
        }
    }

    let bridge_dir = get_bridge_dir();
    ensure_secure_bridge_dir(&bridge_dir)?;
    println!("  Bridge directory verified: {}", bridge_dir.display());

    println!("\nSuccessfully registered omp-firefox-host! No Node.js runtime required.");
    Ok(())
}

pub fn run_uninstall() -> Result<(), Box<dyn std::error::Error>> {
    println!("Unregistering omp-firefox-host from Firefox...");
    let manifest_paths = get_manifest_target_paths();
    for path in &manifest_paths {
        if path.exists() {
            let _ = fs::remove_file(path);
            println!("  Removed manifest: {}", path.display());
        }
    }

    #[cfg(windows)]
    {
        unregister_windows_registry()?;
        println!("  Removed HKCU\\Software\\Mozilla\\NativeMessagingHosts\\omp_firefox");
    }

    println!("Unregistration complete.");
    Ok(())
}

pub fn run_doctor() -> Result<(), Box<dyn std::error::Error>> {
    println!("omp-firefox-host doctor (v{})", HOST_VERSION);
    println!("----------------------------------------");

    let exe_path = std::env::current_exe()?;
    println!("Executable: {}", exe_path.display());

    let manifest_paths = get_manifest_target_paths();
    println!("\nChecking Native Messaging Manifests:");
    let mut found_manifest = false;
    for path in &manifest_paths {
        if path.exists() {
            println!("  [OK] Found: {}", path.display());
            match fs::read_to_string(path) {
                Ok(content) => {
                    if content.contains(&exe_path.to_string_lossy().to_string()) || content.contains("omp-firefox-host") {
                        println!("       Path correctly references omp-firefox-host");
                    } else {
                        println!("       [WARN] Manifest points to different host binary");
                    }
                }
                Err(e) => println!("       [ERROR] Could not read manifest: {}", e),
            }
            found_manifest = true;
        } else {
            println!("  [--] Not present: {}", path.display());
        }
    }

    if !found_manifest {
        println!("  [!] No manifest found. Run 'omp-firefox-host install' to register.");
    }

    let bridge_dir = get_bridge_dir();
    println!("\nChecking Bridge Directory ({}):", bridge_dir.display());
    match ensure_secure_bridge_dir(&bridge_dir) {
        Ok(()) => println!("  [OK] Directory exists with secure permissions."),
        Err(e) => println!("  [FAIL] Directory permissions check failed: {}", e),
    }

    println!("----------------------------------------");
    Ok(())
}

fn get_manifest_target_paths() -> Vec<PathBuf> {
    let home = dirs_home().unwrap_or_else(|| PathBuf::from("."));
    let mut paths = Vec::new();

    #[cfg(target_os = "macos")]
    {
        paths.push(
            home.join("Library")
                .join("Application Support")
                .join("Mozilla")
                .join("NativeMessagingHosts")
                .join("omp_firefox.json"),
        );
    }

    #[cfg(target_os = "linux")]
    {
        paths.push(
            home.join(".mozilla")
                .join("native-messaging-hosts")
                .join("omp_firefox.json"),
        );

        let snap_dir = home.join("snap").join("firefox").join("common").join(".mozilla");
        if snap_dir.exists() {
            paths.push(snap_dir.join("native-messaging-hosts").join("omp_firefox.json"));
        }

        let flatpak_dir = home.join(".var").join("app").join("org.mozilla.firefox").join(".mozilla");
        if flatpak_dir.exists() {
            paths.push(flatpak_dir.join("native-messaging-hosts").join("omp_firefox.json"));
        }
    }

    #[cfg(target_os = "windows")]
    {
        paths.push(home.join(".omp").join("firefox").join("host").join("omp_firefox.json"));
    }

    paths
}

#[cfg(windows)]
fn register_windows_registry(manifest_path: &Path) -> std::io::Result<()> {
    use std::process::Command;
    let status = Command::new("reg.exe")
        .args([
            "add",
            r"HKCU\Software\Mozilla\NativeMessagingHosts\omp_firefox",
            "/ve",
            "/t",
            "REG_SZ",
            "/d",
            &manifest_path.to_string_lossy(),
            "/f",
        ])
        .status()?;
    if !status.success() {
        return Err(std::io::Error::new(std::io::ErrorKind::Other, "reg.exe failed"));
    }
    Ok(())
}

#[cfg(windows)]
fn unregister_windows_registry() -> std::io::Result<()> {
    use std::process::Command;
    let _ = Command::new("reg.exe")
        .args([
            "delete",
            r"HKCU\Software\Mozilla\NativeMessagingHosts\omp_firefox",
            "/f",
        ])
        .status();
    Ok(())
}
