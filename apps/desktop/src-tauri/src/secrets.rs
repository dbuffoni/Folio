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
        keyring::Entry::new(SERVICE, key).and_then(|e| e.set_password(value)).map_err(|e| Error::Io(e.to_string()))
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
        self.0.lock().unwrap().insert(key.to_string(), value.to_string());
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
        let works = candidate.set(probe, "1").is_ok() && matches!(candidate.get(probe), Ok(Some(_)));
        let _ = candidate.remove(probe);
        if works {
            Secrets(candidate)
        } else {
            log::warn!("no usable keyring: secrets are kept in memory for this session only");
            Secrets(Box::new(Memory::default()))
        }
    }
}

fn check_key(key: &str) -> Result<()> {
    if key.starts_with("folio.") && key.len() <= 64 && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
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
}
