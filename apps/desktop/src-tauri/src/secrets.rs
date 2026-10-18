//! Secret storage (SPEC §11.1, §12.4): the OS keychain (Secret Service on Linux, Credential Manager on Windows, Keychain on macOS).
//! When no keyring daemon is reachable, secrets live in memory for the session only and the UI says so.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::State;

use crate::error::{Error, Result};

const SERVICE: &str = "io.github.folio.Folio";

pub trait Backend: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>>;
    fn set(&self, key: &str, value: &str) -> Result<()>;
    fn remove(&self, key: &str) -> Result<()>;
    fn kind(&self) -> &'static str;
}

pub struct Keychain;
impl Backend for Keychain {
    fn get(&self, key: &str) -> Result<Option<String>> {
        match keyring::Entry::new(SERVICE, key).and_then(|e| e.get_password()) {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::Io(e.to_string())),
        }
    }
    fn set(&self, key: &str, value: &str) -> Result<()> {
        keyring::Entry::new(SERVICE, key)
            .and_then(|e| e.set_password(value))
            .map_err(|e| Error::Io(e.to_string()))
    }
    fn remove(&self, key: &str) -> Result<()> {
        match keyring::Entry::new(SERVICE, key).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::Io(e.to_string())),
        }
    }
    fn kind(&self) -> &'static str {
        "os-keychain"
    }
}

#[derive(Default)]
pub struct Memory(Mutex<HashMap<String, String>>);
impl Backend for Memory {
    fn get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.0.lock().unwrap().get(key).cloned())
    }
    fn set(&self, key: &str, value: &str) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
        Ok(())
    }
    fn remove(&self, key: &str) -> Result<()> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
    fn kind(&self) -> &'static str {
        "memory-only"
    }
}

pub struct Secrets(pub Box<dyn Backend>);

impl Secrets {
    /// Probes the keychain with a round trip; any failure selects the in-memory fallback.
    pub fn detect() -> Self {
        Self::select(Box::new(Keychain))
    }
    pub fn select(candidate: Box<dyn Backend>) -> Self {
        let probe = "folio.probe";
        let works =
            candidate.set(probe, "1").is_ok() && matches!(candidate.get(probe), Ok(Some(_)));
        let _ = candidate.remove(probe);
        if works {
            Secrets(candidate)
        } else {
            log::warn!("no usable keyring: secrets are kept in memory for this session only");
            Secrets(Box::new(Memory::default()))
        }
    }
}

/// Longest secret name accepted from the webview. `folio.cert.<SHA-256 hex>` (75 characters) must fit.
const MAX_KEY_LEN: usize = 80;

/// Name under which a signing identity keeps its PKCS#12 data; mirrors `certSecretKey` in @folio/core.
pub fn cert_secret_key(fingerprint: &str) -> String {
    format!("folio.cert.{fingerprint}")
}

/// Removes every secret Folio stores: the fixed names, and one entry per signing identity. The keyring
/// crate cannot list the entries of a service, so identity names come from the `certificates` table of
/// the application database, which records every imported identity by fingerprint.
pub fn wipe(backend: &dyn Backend, db: &crate::db::Db) -> Result<()> {
    // A database without the table (never migrated) simply has no identities.
    let rows = crate::db::select(
        db,
        "SELECT fingerprint FROM certificates WHERE kind = 'identity'",
        &[],
    )
    .unwrap_or_default();
    for row in rows {
        if let Some(fp) = row.get("fingerprint").and_then(|v| v.as_str()) {
            let key = cert_secret_key(fp);
            if check_key(&key).is_ok() {
                backend.remove(&key)?;
            }
        }
    }
    for key in [crate::http::AI_KEY, "folio.data-key"] {
        backend.remove(key)?;
    }
    Ok(())
}

fn check_key(key: &str) -> Result<()> {
    if key.starts_with("folio.")
        && key.len() <= MAX_KEY_LEN
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        Ok(())
    } else {
        Err(Error::Invalid("invalid secret name".into()))
    }
}

#[tauri::command]
pub fn secret_get(key: String, secrets: State<'_, Secrets>) -> Result<Option<String>> {
    check_key(&key)?;
    // The AI key never goes back to the webview: it is only ever used by `http_request`.
    if key == crate::http::AI_KEY {
        return Ok(secrets.0.get(&key)?.map(|_| String::new()));
    }
    secrets.0.get(&key)
}

#[tauri::command]
pub fn secret_set(key: String, value: String, secrets: State<'_, Secrets>) -> Result<()> {
    check_key(&key)?;
    secrets.0.set(&key, &value)
}

#[tauri::command]
pub fn secret_remove(key: String, secrets: State<'_, Secrets>) -> Result<()> {
    check_key(&key)?;
    secrets.0.remove(&key)
}

#[tauri::command]
pub fn secret_backend(secrets: State<'_, Secrets>) -> &'static str {
    secrets.0.kind()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Broken;
    impl Backend for Broken {
        fn get(&self, _: &str) -> Result<Option<String>> {
            Err(Error::Io("no daemon".into()))
        }
        fn set(&self, _: &str, _: &str) -> Result<()> {
            Err(Error::Io("no daemon".into()))
        }
        fn remove(&self, _: &str) -> Result<()> {
            Ok(())
        }
        fn kind(&self) -> &'static str {
            "os-keychain"
        }
    }

    #[test]
    fn falls_back_to_memory_when_the_keyring_is_unusable() {
        let s = Secrets::select(Box::new(Broken));
        assert_eq!(s.0.kind(), "memory-only");
        s.0.set("folio.x", "v").unwrap();
        assert_eq!(s.0.get("folio.x").unwrap().as_deref(), Some("v"));
        s.0.remove("folio.x").unwrap();
        assert_eq!(s.0.get("folio.x").unwrap(), None);
    }

    #[test]
    fn keeps_a_working_backend() {
        let s = Secrets::select(Box::new(Memory::default()));
        assert_eq!(s.0.kind(), "memory-only");
        assert_eq!(s.0.get("folio.probe").unwrap(), None);
    }

    #[test]
    fn secret_names_are_restricted() {
        assert!(check_key("folio.openai-key").is_ok());
        assert!(check_key("other.key").is_err());
        assert!(check_key("folio.bad key").is_err());
        assert!(check_key(&format!("folio.{}", "a".repeat(80))).is_err());
    }

    /// A signing identity is stored as `folio.cert.<SHA-256 hex>` (75 characters, `certSecretKey` in @folio/core).
    #[test]
    fn accepts_the_signing_identity_key_shape() {
        let key = cert_secret_key(&"0123456789abcdef".repeat(4));
        assert_eq!(key.len(), 75);
        assert!(check_key(&key).is_ok());
        assert!(check_key("folio.cert.0123").is_ok());
    }

    #[test]
    fn wipe_removes_fixed_secrets_and_every_identity_recorded_in_the_database() {
        use serde_json::json;
        let db = crate::db::Db::memory();
        crate::db::execute(
            &db,
            "CREATE TABLE certificates (fingerprint TEXT, kind TEXT)",
            &[],
        )
        .unwrap();
        let fp = "ab".repeat(32);
        let trusted = "cd".repeat(32);
        for (f, k) in [
            (fp.as_str(), "identity"),
            (trusted.as_str(), "trusted"),
            ("bad name", "identity"),
        ] {
            crate::db::execute(
                &db,
                "INSERT INTO certificates (fingerprint, kind) VALUES (?, ?)",
                &[json!(f), json!(k)],
            )
            .unwrap();
        }
        let store = Memory::default();
        for key in [
            cert_secret_key(&fp),
            crate::http::AI_KEY.to_string(),
            "folio.data-key".into(),
            "folio.other".into(),
        ] {
            store.set(&key, "v").unwrap();
        }
        wipe(&store, &db).unwrap();
        assert_eq!(store.get(&cert_secret_key(&fp)).unwrap(), None);
        assert_eq!(store.get(crate::http::AI_KEY).unwrap(), None);
        assert_eq!(store.get("folio.data-key").unwrap(), None);
        assert_eq!(store.get("folio.other").unwrap().as_deref(), Some("v"));
    }

    #[test]
    fn wipe_works_before_the_database_has_its_tables() {
        let db = crate::db::Db::memory();
        let store = Memory::default();
        store.set(crate::http::AI_KEY, "k").unwrap();
        wipe(&store, &db).unwrap();
        assert_eq!(store.get(crate::http::AI_KEY).unwrap(), None);
    }
}
