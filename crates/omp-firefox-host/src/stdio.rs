use crate::protocol::{MAX_INBOUND_NATIVE_MSG, MAX_NATIVE_MSG_SIZE};
use std::io::{self, Read, Write};
use std::thread;
use tokio::sync::mpsc;

pub enum StdioInEvent {
    Message(Vec<u8>),
    Eof,
    Error(String),
}

pub struct StdioHandles {
    pub in_rx: mpsc::Receiver<StdioInEvent>,
    pub out_tx: mpsc::Sender<Vec<u8>>,
}

pub fn spawn_stdio_threads() -> StdioHandles {
    let (in_tx, in_rx) = mpsc::channel::<StdioInEvent>(64);
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(64);

    // Stdin reader OS thread
    thread::Builder::new()
        .name("omp-firefox-stdin".to_string())
        .spawn(move || {
            let mut stdin = io::stdin().lock();
            let mut len_buf = [0u8; 4];

            loop {
                match stdin.read_exact(&mut len_buf) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => {
                        let _ = in_tx.blocking_send(StdioInEvent::Eof);
                        break;
                    }
                    Err(e) => {
                        let _ = in_tx.blocking_send(StdioInEvent::Error(e.to_string()));
                        break;
                    }
                }

                let msg_len = u32::from_ne_bytes(len_buf) as usize;
                if msg_len == 0 {
                    continue;
                }
                if msg_len > MAX_INBOUND_NATIVE_MSG {
                    eprintln!("omp-firefox-host: inbound message from Firefox exceeds limit: {} bytes", msg_len);
                    let _ = in_tx.blocking_send(StdioInEvent::Error(format!(
                        "Inbound message exceeded {} bytes limit",
                        MAX_INBOUND_NATIVE_MSG
                    )));
                    break;
                }

                let mut body = vec![0u8; msg_len];
                match stdin.read_exact(&mut body) {
                    Ok(()) => {
                        if in_tx.blocking_send(StdioInEvent::Message(body)).is_err() {
                            break;
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => {
                        eprintln!("omp-firefox-host: unexpected EOF while reading message body");
                        let _ = in_tx.blocking_send(StdioInEvent::Eof);
                        break;
                    }
                    Err(e) => {
                        let _ = in_tx.blocking_send(StdioInEvent::Error(e.to_string()));
                        break;
                    }
                }
            }
        })
        .expect("failed to spawn stdin thread");

    // Stdout writer OS thread
    thread::Builder::new()
        .name("omp-firefox-stdout".to_string())
        .spawn(move || {
            let mut stdout = io::stdout().lock();

            while let Some(msg) = out_rx.blocking_recv() {
                if msg.len() > MAX_NATIVE_MSG_SIZE {
                    eprintln!(
                        "omp-firefox-host: outbound message exceeds 1 MB limit ({} bytes), dropping",
                        msg.len()
                    );
                    continue;
                }

                let len_bytes = (msg.len() as u32).to_ne_bytes();
                // Combine length header and body into single write buffer
                let mut combined = Vec::with_capacity(4 + msg.len());
                combined.extend_from_slice(&len_bytes);
                combined.extend_from_slice(&msg);

                if let Err(e) = stdout.write_all(&combined).and_then(|_| stdout.flush()) {
                    if e.kind() != io::ErrorKind::BrokenPipe {
                        eprintln!("omp-firefox-host: stdout write error: {}", e);
                    }
                    break;
                }
            }
        })
        .expect("failed to spawn stdout thread");

    StdioHandles { in_rx, out_tx }
}
