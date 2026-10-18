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
// A local model running on the CPU may take minutes (FR-AIF-12); remote endpoints ask for 60 s.
const MAX_TIMEOUT_MS: u64 = 180_000;

/// The single origin `http_request` may talk to. Stored outside the webview's reach.
pub struct AllowedOrigin {
    origin: Mutex<String>,
    file: Option<PathBuf>,
}

/// True for a server on this computer (Ollama, LM Studio, llama.cpp): no key is needed there.
pub fn is_loopback(url: &str) -> bool {
    url::Url::parse(url).map(|u| matches!(u.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]"))).unwrap_or(false)
}

/// The value of a secret header, or `None` when it can be left out: a local server without a stored
/// key gets no Authorization header, a remote endpoint without a key is an error.
pub fn secret_header_value(url: &str, secret: Option<String>, format: Option<&str>) -> Result<Option<String>> {
    match secret {
        Some(s) => Ok(Some(format.unwrap_or("{secret}").replace("{secret}", &s))),
        None if is_loopback(url) => Ok(None),
        None => Err(Error::Invalid("the API key is not set".into())),
    }
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
        if let Some(value) = secret_header_value(&req.url, secrets.0.get(&r.secret)?, r.format.as_deref())? {
            builder = builder.header(name, value);
        }
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

/// Hosts OCR language data may come from (FR-OCR-02). Fixed in the binary: page content cannot extend it.
pub const DOWNLOAD_HOSTS: &[&str] = &["raw.githubusercontent.com"];

/// Checks a download request: https only, host on the allow-list, no credentials, no custom port.
pub fn download_allowed(url: &str) -> Result<url::Url> {
    let u = url::Url::parse(url).map_err(|_| Error::Invalid("invalid URL".into()))?;
    let host_ok = u.host_str().map(|h| DOWNLOAD_HOSTS.contains(&h)).unwrap_or(false);
    if u.scheme() != "https" || !host_ok || !u.username().is_empty() || u.password().is_some() || u.port().is_some() {
        return Err(Error::Invalid("downloads are only allowed from the OCR language host".into()));
    }
    Ok(u)
}

/// Downloads a file for the OCR language manager. The caller verifies the SHA-256 against the manifest
/// bundled with the app; this command only enforces where the bytes may come from and how big they are.
#[tauri::command]
pub async fn download_file(url: String, max_bytes: u64) -> Result<tauri::ipc::Response> {
    let u = download_allowed(&url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| Error::Network(e.to_string()))?;
    let res = client.get(u).send().await.map_err(|e| Error::Network(e.without_url().to_string()))?;
    if !res.status().is_success() {
        return Err(Error::Network(format!("HTTP {}", res.status().as_u16())));
    }
    if res.content_length().map(|n| n > max_bytes).unwrap_or(false) {
        return Err(Error::Network("the file is larger than expected".into()));
    }
    let bytes = res.bytes().await.map_err(|e| Error::Network(e.without_url().to_string()))?;
    if bytes.len() as u64 > max_bytes {
        return Err(Error::Network("the file is larger than expected".into()));
    }
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

/// Hosts the user approved for signature traffic (timestamp, OCSP and CRL servers) in this run.
#[derive(Default)]
pub struct ApprovedNetworkHosts(Mutex<Vec<String>>);

const SIGNATURE_MAX_BODY: usize = 1024 * 1024;
const SIGNATURE_MAX_RESPONSE: usize = 8 * 1024 * 1024;

/// Checks a signature-network request: http or https, no credentials, GET or POST. Returns the host.
pub fn signature_target(url: &str, method: &str) -> Result<(url::Url, String)> {
    let u = url::Url::parse(url).map_err(|_| Error::Invalid("invalid URL".into()))?;
    if !matches!(u.scheme(), "http" | "https") || !u.username().is_empty() || u.password().is_some() {
        return Err(Error::Invalid("only http and https addresses without credentials are allowed".into()));
    }
    if !matches!(method.to_uppercase().as_str(), "GET" | "POST") {
        return Err(Error::Invalid("only GET and POST are allowed".into()));
    }
    let host = u.host_str().ok_or_else(|| Error::Invalid("the address has no host".into()))?.to_string();
    Ok((u, host))
}

/// Timestamp and revocation requests of digital signatures (FR-SIG-06…08). Each new host is approved by
/// the user in a native dialog before anything is sent, so page content cannot make Folio talk to a server
/// the user did not choose. Nothing but the request bytes leaves: no cookies, no referrer, no redirects.
#[tauri::command]
pub async fn binary_request(
    app: AppHandle,
    url: String,
    method: String,
    body: Option<Vec<u8>>,
    content_type: Option<String>,
    approved: State<'_, ApprovedNetworkHosts>,
) -> Result<tauri::ipc::Response> {
    let (u, host) = signature_target(&url, &method)?;
    if body.as_ref().map(|b| b.len() > SIGNATURE_MAX_BODY).unwrap_or(false) {
        return Err(Error::Invalid("request body is too large".into()));
    }
    let known = approved.0.lock().unwrap().contains(&host);
    if !known {
        let ok = app
            .dialog()
            .message(format!("Allow Folio to contact\n\n{host}\n\nfor a digital signature (timestamp or revocation check)? The request names the certificate or signature being checked, never the document."))
            .title("Contact a signature server")
            .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Cancel".into()))
            .blocking_show();
        if !ok {
            return Err(Error::Network("the server was not approved".into()));
        }
        approved.0.lock().unwrap().push(host);
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| Error::Network(e.to_string()))?;
    let m = if method.eq_ignore_ascii_case("POST") { reqwest::Method::POST } else { reqwest::Method::GET };
    let mut builder = client.request(m, u);
    if let Some(ct) = content_type {
        builder = builder.header("Content-Type", ct);
    }
    if let Some(b) = body {
        builder = builder.body(b);
    }
    let res = builder.send().await.map_err(|e| Error::Network(e.without_url().to_string()))?;
    if !res.status().is_success() {
        return Err(Error::Network(format!("HTTP {}", res.status().as_u16())));
    }
    let bytes = res.bytes().await.map_err(|e| Error::Network(e.without_url().to_string()))?;
    if bytes.len() > SIGNATURE_MAX_RESPONSE {
        return Err(Error::Network("response is too large".into()));
    }
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
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
    fn local_servers_need_no_key_remote_ones_do() {
        assert_eq!(secret_header_value("http://localhost:11434/v1/models", None, Some("Bearer {secret}")).unwrap(), None);
        assert_eq!(secret_header_value("http://127.0.0.1:1234/v1/models", None, None).unwrap(), None);
        assert_eq!(
            secret_header_value("http://localhost:11434/v1/models", Some("sk-1".into()), Some("Bearer {secret}")).unwrap(),
            Some("Bearer sk-1".into())
        );
        assert!(secret_header_value("https://api.openai.com/v1/models", None, Some("Bearer {secret}")).is_err());
        assert!(!is_loopback("https://localhost.evil.example/v1"));
    }

    #[test]
    fn downloads_are_limited_to_the_language_host() {
        assert!(download_allowed("https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/deu.traineddata").is_ok());
        assert!(download_allowed("http://raw.githubusercontent.com/x").is_err());
        assert!(download_allowed("https://raw.githubusercontent.com.evil.example/x").is_err());
        assert!(download_allowed("https://evil.example/raw.githubusercontent.com").is_err());
        assert!(download_allowed("https://user:pw@raw.githubusercontent.com/x").is_err());
        assert!(download_allowed("https://raw.githubusercontent.com:8443/x").is_err());
        assert!(download_allowed("file:///etc/passwd").is_err());
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

    #[test]
    fn signature_targets_are_checked() {
        assert!(signature_target("http://tsa.example.org/ts", "POST").is_ok());
        assert!(signature_target("https://ocsp.example.org/", "get").is_ok());
        assert!(signature_target("ftp://x.example.org/", "GET").is_err());
        assert!(signature_target("https://user:pw@x.example.org/", "GET").is_err());
        assert!(signature_target("https://x.example.org/", "DELETE").is_err());
        assert!(signature_target("not a url", "GET").is_err());
    }
}
