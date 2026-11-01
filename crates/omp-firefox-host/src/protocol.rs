use serde_json::value::RawValue;
use std::collections::HashMap;

pub const MAX_NATIVE_MSG_SIZE: usize = 1_000_000; // 1 MB limit for Firefox native messaging
pub const MAX_INBOUND_NATIVE_MSG: usize = 64 * 1024 * 1024; // 64 MB inbound safety cap from Firefox
pub const MAX_LINE_BUFFER: usize = 64 * 1024 * 1024; // 64 MB line buffer limit for client IPC
pub const HOST_VERSION: &str = env!("CARGO_PKG_VERSION");
#[allow(dead_code)]
pub const PROTOCOL_VERSION: u32 = 1;

pub type Envelope = HashMap<String, Box<RawValue>>;

/// Inspects the "method" field of an unparsed JSON request.
pub fn extract_method(env: &Envelope) -> Option<String> {
    env.get("method").and_then(|val| {
        serde_json::from_str::<String>(val.get()).ok()
    })
}

/// Inspects the "type" field of an unparsed JSON message.
pub fn extract_type(env: &Envelope) -> Option<String> {
    env.get("type").and_then(|val| {
        serde_json::from_str::<String>(val.get()).ok()
    })
}

/// Inspects the numeric "id" field of a response from the extension.
pub fn extract_numeric_id(env: &Envelope) -> Option<u64> {
    env.get("id").and_then(|val| {
        val.get().trim().parse::<u64>().ok()
    })
}

/// Rewrites the "id" field in a client request to the host-assigned sequence ID.
/// Returns the serialized bytes to send to Firefox and the original ID RawValue.
pub fn rewrite_request_id(
    body: &[u8],
    new_id: u64,
) -> Result<(Vec<u8>, Option<Box<RawValue>>), serde_json::Error> {
    let mut env: Envelope = serde_json::from_slice(body)?;
    let orig_id = env.remove("id");
    let new_id_raw = RawValue::from_string(new_id.to_string())?;
    env.insert("id".to_string(), new_id_raw);
    
    // Ensure "type": "request" is present as expected by extension
    if !env.contains_key("type") {
        env.insert("type".to_string(), RawValue::from_string("\"request\"".to_string())?);
    }
    
    // Ensure "params" is present (defaulting to {})
    if !env.contains_key("params") {
        env.insert("params".to_string(), RawValue::from_string("{}".to_string())?);
    }
    
    let bytes = serde_json::to_vec(&env)?;
    Ok((bytes, orig_id))
}

/// Restores the original client "id" in a response from the extension and appends '\n'.
pub fn restore_response_id(
    body: &[u8],
    orig_id: Option<&RawValue>,
) -> Result<Vec<u8>, serde_json::Error> {
    let mut env: Envelope = serde_json::from_slice(body)?;
    if let Some(id) = orig_id {
        let boxed = RawValue::from_string(id.get().to_string())?;
        env.insert("id".to_string(), boxed);
    }
    let mut bytes = serde_json::to_vec(&env)?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Constructs a client-count broadcast message for the extension.
pub fn make_clients_broadcast(count: usize) -> Vec<u8> {
    format!(r#"{{"type":"clients","count":{}}}"#, count).into_bytes()
}

/// Constructs an oversize error response line for the client.
pub fn make_oversize_error(orig_id: Option<&RawValue>, byte_len: usize) -> Vec<u8> {
    let id_str = orig_id.map(|v| v.get()).unwrap_or("null");
    format!(
        r#"{{"id":{},"ok":false,"error":"Request too large for Firefox native messaging ({} bytes; limit 1 MB)."}}{}"#,
        id_str, byte_len, "\n"
    )
    .into_bytes()
}

/// Constructs a ping response line for the client.
pub fn make_ping_response(
    orig_id: Option<&RawValue>,
    pid: u32,
    browser_session: Option<&str>,
) -> Vec<u8> {
    let id_str = orig_id.map(|v| v.get()).unwrap_or("null");
    let session_str = match browser_session {
        Some(s) => format!(r#""{}""#, s),
        None => "null".to_string(),
    };
    format!(
        r#"{{"id":{},"ok":true,"result":{{"version":"{}","pid":{},"extensionBrowserSession":{}}}}}{}"#,
        id_str, HOST_VERSION, pid, session_str, "\n"
    )
    .into_bytes()
}

/// Constructs a generic error response line for the client.
pub fn make_error_response(orig_id: Option<&RawValue>, error_msg: &str) -> Vec<u8> {
    let id_str = orig_id.map(|v| v.get()).unwrap_or("null");
    let escaped_error = serde_json::to_string(error_msg).unwrap_or_else(|_| "\"error\"".to_string());
    format!(r#"{{"id":{},"ok":false,"error":{}}}{}"#, id_str, escaped_error, "\n").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rewrite_and_restore_request_id() {
        let client_req = br#"{"id":100,"method":"tabs","params":{"action":"list"}}"#;
        let (ext_msg, stashed_id) = rewrite_request_id(client_req, 1).expect("rewrite succeeds");

        assert!(stashed_id.is_some());
        assert_eq!(stashed_id.unwrap().get(), "100");

        let parsed: serde_json::Value = serde_json::from_slice(&ext_msg).unwrap();
        assert_eq!(parsed["id"], 1);
        assert_eq!(parsed["type"], "request");
        assert_eq!(parsed["method"], "tabs");

        let ext_resp = br#"{"id":1,"ok":true,"result":[{"id":42}]}"#;
        let orig_id = RawValue::from_string("100".to_string()).unwrap();
        let client_resp = restore_response_id(ext_resp, Some(&orig_id)).expect("restore succeeds");

        assert!(client_resp.ends_with(b"\n"));
        let parsed_client: serde_json::Value = serde_json::from_slice(&client_resp).unwrap();
        assert_eq!(parsed_client["id"], 100);
        assert_eq!(parsed_client["ok"], true);
    }

    #[test]
    fn test_ping_response_generation() {
        let orig_id = RawValue::from_string("42".to_string()).unwrap();
        let resp = make_ping_response(Some(&orig_id), 1234, Some("test-session"));
        let parsed: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert_eq!(parsed["id"], 42);
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["result"]["pid"], 1234);
        assert_eq!(parsed["result"]["extensionBrowserSession"], "test-session");
    }
}
