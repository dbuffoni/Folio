//! HTTP proxy for the AI feature (SPEC §11.1): no CORS, the API key is injected here and never
//! exposed to webview JavaScript, and requests can only go to the AI endpoint the user approved
//! in a native dialog.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use crate::error::{Error, Result};
use crate::secrets::Secrets;

pub const AI_KEY: &str = "folio.openai-key";
pub const DEFAULT_ORIGIN: &str = "https://api.openai.com";
const MAX_BODY: usize = 8 * 1024 * 1024;
const MAX_TIMEOUT_MS: u64 = 120_000;

/// The single origin `http_request` may talk to. Stored outside the webview's reach.
pub struct AllowedOrigin {
    origin: Mutex<String>,
    file: Option<PathBuf>,
}

pub fn origin_of(url: &str) -> Result<String> {
    let u = url::Url::parse(url).map_err(|_| Error::Invalid("invalid URL".into()))?;
    let local = matches!(u.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]"));
    match u.scheme() {
        "https" => {}
        // Plain HTTP only for a model running on this machine.
        "http" if local => {}
        _ => return Err(Error::Invalid("the AI endpoint must use https".into())),
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(Error::Invalid("credentials in the URL are not allowed".into()));
    }
    Ok(u.origin().ascii_serialization())
}

impl AllowedOrigin {
    pub fn new(file: Option<PathBuf>) -> Self {
        let stored = file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|s| origin_of(s.trim()).ok());
        AllowedOrigin { origin: Mutex::new(stored.unwrap_or_else(|| DEFAULT_ORIGIN.to_string())), file }
    }
    pub fn get(&self) -> String {
        self.origin.lock().unwrap().clone()
    }
    pub fn set(&self, origin: String) {
        if let Some(f) = &self.file {
            if let Some(dir) = f.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(f, &origin);
        }
        *self.origin.lock().unwrap() = origin;
    }
    pub fn permits(&self, url: &str) -> bool {
        origin_of(url).map(|o| o == self.get()).unwrap_or(false)
    }
}

#[derive(Deserialize)]
pub struct SecretRef {
    secret: String,
    format: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    url: String,
    method: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    body: Option<String>,
    timeout_ms: Option<u64>,
    #[serde(default)]
    secret_headers: HashMap<String, SecretRef>,
}

#[derive(Serialize)]
pub struct HttpResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

#[tauri::command]
pub fn ai_origin(allowed: State<'_, AllowedOrigin>) -> String {
    allowed.get()
}

/// Changes the AI endpoint. The user confirms the new host in a native dialog, so page content
/// cannot silently redirect requests (and the stored key) elsewhere.
#[tauri::command]
pub async fn set_ai_origin(app: AppHandle, url: String, allowed: State<'_, AllowedOrigin>) -> Result<bool> {
    let origin = origin_of(&url)?;
    if origin == allowed.get() {
        return Ok(true);
    }
    let ok = app
        .dialog()
        .message(format!("Allow Folio to send AI requests, including your API key, to\n\n{origin}\n\nOnly continue if you entered this address yourself."))
        .title("Change AI endpoint")
        .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Cancel".into()))
        .blocking_show();
    if ok {
        allowed.set(origin);
    }
    Ok(ok)
}

#[tauri::command]
pub async fn http_request(req: HttpRequest, allowed: State<'_, AllowedOrigin>, secrets: State<'_, Secrets>) -> Result<HttpResponse> {
    if !allowed.permits(&req.url) {
        return Err(Error::Invalid("this host is not the configured AI endpoint".into()));
    }
    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes()).map_err(|_| Error::Invalid("invalid method".into()))?;
    if method != reqwest::Method::GET && method != reqwest::Method::POST {
        return Err(Error::Invalid("only GET and POST are allowed".into()));
    }
    if req.body.as_ref().map(|b| b.len() > MAX_BODY).unwrap_or(false) {
        return Err(Error::Invalid("request body is too large".into()));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(req.timeout_ms.unwrap_or(60_000).min(MAX_TIMEOUT_MS)))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| Error::Network(e.to_string()))?;
    let mut builder = client.request(method, &req.url);
    for (k, v) in &req.headers {
        builder = builder.header(k, v);
    }
    for (name, r) in &req.secret_headers {
        let secret = secrets.0.get(&r.secret)?.ok_or_else(|| Error::Invalid("the API key is not set".into()))?;
        builder = builder.header(name, r.format.as_deref().unwrap_or("{secret}").replace("{secret}", &secret));
    }
    if let Some(body) = req.body {
        builder = builder.body(body);
    }
    let res = builder.send().await.map_err(|e| Error::Network(e.without_url().to_string()))?;
    let status = res.status().as_u16();
    let headers = res.headers().iter().filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), v.to_string()))).collect();
    let bytes = res.bytes().await.map_err(|e| Error::Network(e.without_url().to_string()))?;
    if bytes.len() > MAX_BODY {
        return Err(Error::Network("response is too large".into()));
    }
    Ok(HttpResponse { status, headers, body: String::from_utf8_lossy(&bytes).to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_or_local_origins_are_accepted() {
        assert_eq!(origin_of("https://api.openai.com/v1/chat").unwrap(), "https://api.openai.com");
        assert_eq!(origin_of("http://localhost:11434/v1").unwrap(), "http://localhost:11434");
        assert_eq!(origin_of("http://127.0.0.1:8080/x").unwrap(), "http://127.0.0.1:8080");
        assert!(origin_of("http://example.com/v1").is_err());
        assert!(origin_of("ftp://example.com").is_err());
        assert!(origin_of("https://user:pw@example.com").is_err());
        assert!(origin_of("not a url").is_err());
    }

    #[test]
    fn allow_list_matches_the_origin_exactly() {
        let a = AllowedOrigin::new(None);
        assert!(a.permits("https://api.openai.com/v1/models"));
        assert!(!a.permits("https://api.openai.com.evil.example/v1/models"));
        assert!(!a.permits("https://evil.example/?u=https://api.openai.com"));
        assert!(!a.permits("http://api.openai.com/v1/models"));
        assert!(!a.permits("https://api.openai.com:8443/v1"));
        a.set("http://localhost:11434".into());
        assert!(a.permits("http://localhost:11434/v1/chat/completions"));
        assert!(!a.permits("https://api.openai.com/v1/models"));
    }

    #[test]
    fn approved_origin_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("ai-origin");
        AllowedOrigin::new(Some(file.clone())).set("https://llm.example.org".into());
        assert_eq!(AllowedOrigin::new(Some(file.clone())).get(), "https://llm.example.org");
        std::fs::write(&file, "javascript:alert(1)").unwrap();
        assert_eq!(AllowedOrigin::new(Some(file)).get(), DEFAULT_ORIGIN);
    }
}
