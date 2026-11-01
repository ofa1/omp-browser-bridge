mod cli;
mod platform;
mod protocol;
mod router;
mod stdio;

use cli::{parse_args, print_help, run_doctor, run_install, run_uninstall, CliCommand};
use platform::{bind_ipc_listener, clean_stale_endpoints, ensure_secure_bridge_dir, get_bridge_dir, write_metadata_atomic};
use protocol::{HOST_VERSION, MAX_LINE_BUFFER};
use router::{ClientId, Router, RouterCmd};
use stdio::{spawn_stdio_threads, StdioInEvent};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cmd = parse_args();
    match cmd {
        CliCommand::Install => return run_install(),
        CliCommand::Uninstall => return run_uninstall(),
        CliCommand::Doctor => return run_doctor(),
        CliCommand::Version => {
            println!("omp-firefox-host {}", HOST_VERSION);
            return Ok(());
        }
        CliCommand::Help => {
            print_help();
            return Ok(());
        }
        CliCommand::RunNativeHost => {}
    }

    // Build Tokio current_thread runtime for minimal footprint and low RSS
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;

    rt.block_on(run_host())
}

async fn run_host() -> Result<(), Box<dyn std::error::Error>> {
    let bridge_dir = get_bridge_dir();
    ensure_secure_bridge_dir(&bridge_dir)?;
    clean_stale_endpoints(&bridge_dir);

    let pid = std::process::id();
    let listener_wrapper = bind_ipc_listener(&bridge_dir, pid).await?;

    #[cfg(unix)]
    let endpoint_str = listener_wrapper.sock_path.to_string_lossy().to_string();
    #[cfg(windows)]
    let endpoint_str = listener_wrapper.pipe_name.clone();

    // Write initial process metadata
    write_metadata_atomic(&bridge_dir, pid, &endpoint_str, None)?;

    // Spawn native messaging stdio reader and writer threads
    let stdio = spawn_stdio_threads();

    // Channel to the router actor
    let (router_tx, router_rx) = mpsc::channel::<RouterCmd>(128);

    // Forward stdin events to router
    let stdio_router_tx = router_tx.clone();
    let mut in_rx = stdio.in_rx;
    tokio::spawn(async move {
        while let Some(evt) = in_rx.recv().await {
            match evt {
                StdioInEvent::Message(msg) => {
                    if stdio_router_tx.send(RouterCmd::ExtensionMessage(msg)).await.is_err() {
                        break;
                    }
                }
                StdioInEvent::Eof => {
                    let _ = stdio_router_tx.send(RouterCmd::Shutdown).await;
                    break;
                }
                StdioInEvent::Error(err) => {
                    eprintln!("omp-firefox-host: stdin stream error: {}", err);
                    let _ = stdio_router_tx.send(RouterCmd::Shutdown).await;
                    break;
                }
            }
        }
    });

    // Handle OS signals (SIGINT, SIGTERM)
    let sig_router_tx = router_tx.clone();
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut sigint = signal(SignalKind::interrupt()).ok();
            let mut sigterm = signal(SignalKind::terminate()).ok();

            tokio::select! {
                _ = async { if let Some(s) = &mut sigint { s.recv().await; } } => {}
                _ = async { if let Some(s) = &mut sigterm { s.recv().await; } } => {}
            }
        }
        #[cfg(windows)]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        let _ = sig_router_tx.send(RouterCmd::Shutdown).await;
    });

    // Start router actor
    let router = Router::new(
        router_rx,
        stdio.out_tx,
        bridge_dir.clone(),
        pid,
        endpoint_str.clone(),
    );
    let mut router_handle = tokio::spawn(router.run());

    // Accept loop for IPC client connections
    let mut next_client_id: ClientId = 0;

    #[cfg(unix)]
    {
        let listener = listener_wrapper.listener;
        loop {
            tokio::select! {
                accept_res = listener.accept() => {
                    let (stream, _) = match accept_res {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("omp-firefox-host: accept error: {}", e);
                            break;
                        }
                    };

                    // Defense in depth: verify connecting process UID matches current user
                    if !platform::verify_client_peer(&stream) {
                        eprintln!("omp-firefox-host: rejected client with mismatched UID");
                        continue;
                    }

                    next_client_id += 1;
                    let client_id = next_client_id;
                    spawn_client_handler(stream, client_id, router_tx.clone());
                }
                _ = &mut router_handle => {
                    break;
                }
            }
        }
    }

    #[cfg(windows)]
    {
        let mut server = listener_wrapper.server;
        let options = listener_wrapper.options;
        let pipe_name = listener_wrapper.pipe_name;

        loop {
            tokio::select! {
                connect_res = server.connect() => {
                    if let Err(e) = connect_res {
                        eprintln!("omp-firefox-host: pipe connect error: {}", e);
                        break;
                    }
                    let connected_client = server;
                    // Create the next pipe instance before processing connected one
                    match options.create(&pipe_name) {
                        Ok(next_server) => {
                            server = next_server;
                        }
                        Err(e) => {
                            eprintln!("omp-firefox-host: failed to create next pipe instance: {}", e);
                            break;
                        }
                    }

                    next_client_id += 1;
                    let client_id = next_client_id;
                    spawn_client_handler(connected_client, client_id, router_tx.clone());
                }
                _ = &mut router_handle => {
                    break;
                }
            }
        }
    }

    Ok(())
}

fn spawn_client_handler<S>(stream: S, client_id: ClientId, router_tx: mpsc::Sender<RouterCmd>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + 'static + Send,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let (client_tx, mut client_rx) = mpsc::channel::<Vec<u8>>(64);

    // Notify router that client connected
    let conn_router_tx = router_tx.clone();
    tokio::spawn(async move {
        let _ = conn_router_tx
            .send(RouterCmd::ClientConnected {
                client_id,
                tx: client_tx,
            })
            .await;
    });

    // Client writer task
    tokio::spawn(async move {
        while let Some(msg) = client_rx.recv().await {
            if writer.write_all(&msg).await.is_err() {
                break;
            }
        }
        let _ = writer.shutdown().await;
    });

    // Client reader task
    let disc_router_tx = router_tx.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.len() > MAX_LINE_BUFFER {
                eprintln!("omp-firefox-host: client line exceeded 64 MB cap");
                break;
            }
            if line.trim().is_empty() {
                continue;
            }
            let mut line_bytes = line.into_bytes();
            line_bytes.push(b'\n');
            if router_tx
                .send(RouterCmd::ClientMessage {
                    client_id,
                    line: line_bytes,
                })
                .await
                .is_err()
            {
                break;
            }
        }

        let _ = disc_router_tx
            .send(RouterCmd::ClientDisconnected { client_id })
            .await;
    });
}
