use crate::platform::{remove_metadata, write_metadata_atomic};
use crate::protocol::*;
use serde_json::value::RawValue;
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::sync::mpsc;

pub type ClientId = usize;

pub enum RouterCmd {
    ClientConnected {
        client_id: ClientId,
        tx: mpsc::Sender<Vec<u8>>,
    },
    ClientDisconnected {
        client_id: ClientId,
    },
    ClientMessage {
        client_id: ClientId,
        line: Vec<u8>,
    },
    ExtensionMessage(Vec<u8>),
    Shutdown,
}

pub struct Router {
    rx: mpsc::Receiver<RouterCmd>,
    stdout_tx: mpsc::Sender<Vec<u8>>,
    pending_requests: HashMap<u64, (ClientId, Option<Box<RawValue>>)>,
    clients: HashMap<ClientId, mpsc::Sender<Vec<u8>>>,
    seq: u64,
    extension_browser_session: Option<String>,
    bridge_dir: PathBuf,
    pid: u32,
    endpoint: String,
}

impl Router {
    pub fn new(
        rx: mpsc::Receiver<RouterCmd>,
        stdout_tx: mpsc::Sender<Vec<u8>>,
        bridge_dir: PathBuf,
        pid: u32,
        endpoint: String,
    ) -> Self {
        Self {
            rx,
            stdout_tx,
            pending_requests: HashMap::new(),
            clients: HashMap::new(),
            seq: 0,
            extension_browser_session: None,
            bridge_dir,
            pid,
            endpoint,
        }
    }

    pub async fn run(mut self) {
        while let Some(cmd) = self.rx.recv().await {
            match cmd {
                RouterCmd::ClientConnected { client_id, tx } => {
                    self.clients.insert(client_id, tx);
                    let _ = self.stdout_tx.send(make_clients_broadcast(self.clients.len())).await;
                }
                RouterCmd::ClientDisconnected { client_id } => {
                    self.clients.remove(&client_id);
                    self.pending_requests.retain(|_, (cid, _)| *cid != client_id);
                    let _ = self.stdout_tx.send(make_clients_broadcast(self.clients.len())).await;
                }
                RouterCmd::ClientMessage { client_id, line } => {
                    self.handle_client_message(client_id, &line).await;
                }
                RouterCmd::ExtensionMessage(bytes) => {
                    self.handle_extension_message(&bytes).await;
                }
                RouterCmd::Shutdown => {
                    break;
                }
            }
        }

        self.cleanup();
    }

    async fn handle_client_message(&mut self, client_id: ClientId, line: &[u8]) {
        let env: Envelope = match serde_json::from_slice(line) {
            Ok(e) => e,
            Err(_) => return,
        };

        let orig_id = env.get("id").map(|v| RawValue::from_string(v.get().to_string()).unwrap());

        if let Some(method) = extract_method(&env) {
            if method == "ping" {
                let resp = make_ping_response(
                    orig_id.as_deref(),
                    self.pid,
                    self.extension_browser_session.as_deref(),
                );
                self.send_to_client(client_id, resp);
                return;
            }
        }

        self.seq += 1;
        let new_id = self.seq;

        let (ext_msg, stashed_id) = match rewrite_request_id(line, new_id) {
            Ok(res) => res,
            Err(e) => {
                let err_resp = make_error_response(orig_id.as_deref(), &format!("Failed to frame request: {}", e));
                self.send_to_client(client_id, err_resp);
                return;
            }
        };

        if ext_msg.len() > MAX_NATIVE_MSG_SIZE {
            let err_resp = make_oversize_error(orig_id.as_deref(), ext_msg.len());
            self.send_to_client(client_id, err_resp);
            return;
        }

        self.pending_requests.insert(new_id, (client_id, stashed_id));
        let _ = self.stdout_tx.send(ext_msg).await;
    }

    async fn handle_extension_message(&mut self, bytes: &[u8]) {
        let env: Envelope = match serde_json::from_slice(bytes) {
            Ok(e) => e,
            Err(_) => return,
        };

        if let Some(msg_type) = extract_type(&env) {
            if msg_type == "hello" {
                if let Some(session_val) = env.get("browserSession") {
                    if let Ok(session_str) = serde_json::from_str::<String>(session_val.get()) {
                        self.extension_browser_session = Some(session_str.clone());
                        let _ = write_metadata_atomic(
                            &self.bridge_dir,
                            self.pid,
                            &self.endpoint,
                            Some(&session_str),
                        );
                    }
                }
                let _ = self.stdout_tx.send(make_clients_broadcast(self.clients.len())).await;
                return;
            }
        }

        if let Some(id) = extract_numeric_id(&env) {
            if let Some((client_id, orig_id)) = self.pending_requests.remove(&id) {
                if let Ok(client_resp) = restore_response_id(bytes, orig_id.as_deref()) {
                    self.send_to_client(client_id, client_resp);
                }
            }
        }
    }

    fn send_to_client(&mut self, client_id: ClientId, msg: Vec<u8>) {
        if let Some(tx) = self.clients.get(&client_id) {
            // Non-blocking try_send prevents head-of-line blocking from a slow or hung client
            if let Err(mpsc::error::TrySendError::Full(_)) = tx.try_send(msg) {
                eprintln!("omp-firefox-host: client {} channel full, disconnecting", client_id);
                self.clients.remove(&client_id);
            }
        }
    }

    fn cleanup(&self) {
        remove_metadata(&self.bridge_dir, self.pid);
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&self.endpoint);
        }
    }
}
