// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;

/// Run the WhatsApp pipeline: read the local Baileys bridge `/digest`, then (if
/// a backend is configured) POST it to the hosted summarizer and return the
/// summarized result. Network is done in Rust so it bypasses webview CSP/ATS.
///
/// Returns the summarizer's response, or — when no backend is set — the raw
/// digest mapped to chats with `summary: null` (clearly unsummarized, not faked).
#[tauri::command]
async fn run_pipeline(
    bridge_url: String,
    backend_url: String,
    token: String,
    days: u32,
) -> Result<Value, String> {
    let client = reqwest::Client::new();

    let digest_url = format!(
        "{}/digest?days={}",
        bridge_url.trim_end_matches('/'),
        days.max(1)
    );
    let digest_res = client
        .get(&digest_url)
        .send()
        .await
        .map_err(|e| format!("bridge unreachable at {digest_url}: {e}"))?;
    if !digest_res.status().is_success() {
        return Err(format!("bridge returned {} for /digest", digest_res.status()));
    }
    let digest: Value = digest_res
        .json()
        .await
        .map_err(|e| format!("bridge digest not JSON: {e}"))?;

    if backend_url.trim().is_empty() {
        // No summarizer configured: show the raw chats, clearly unsummarized.
        let chats = digest.get("chats").cloned().unwrap_or(Value::Array(vec![]));
        return Ok(serde_json::json!({
            "source": "digest",
            "summarized": false,
            "generated": digest.get("generated"),
            "chats": chats,
        }));
    }

    let summarize_url = format!("{}/summarize", backend_url.trim_end_matches('/'));
    let mut req = client.post(&summarize_url).json(&digest);
    if !token.trim().is_empty() {
        req = req.bearer_auth(token.trim());
    }
    let res = req
        .send()
        .await
        .map_err(|e| format!("summarizer unreachable at {summarize_url}: {e}"))?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("summarizer returned {status}: {}", body.chars().take(300).collect::<String>()));
    }
    let mut out: Value = res
        .json()
        .await
        .map_err(|e| format!("summarizer response not JSON: {e}"))?;
    if let Value::Object(ref mut map) = out {
        map.insert("source".into(), Value::String("backend".into()));
        map.insert("summarized".into(), Value::Bool(true));
    }
    Ok(out)
}

/// Quick health probe of the local bridge.
#[tauri::command]
async fn bridge_health(bridge_url: String) -> Result<Value, String> {
    let url = format!("{}/health", bridge_url.trim_end_matches('/'));
    let res = reqwest::get(&url)
        .await
        .map_err(|e| format!("bridge unreachable: {e}"))?;
    res.json::<Value>()
        .await
        .map_err(|e| format!("health not JSON: {e}"))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![run_pipeline, bridge_health])
        .run(tauri::generate_context!())
        .expect("error while running Command Tab WhatsApp");
}
