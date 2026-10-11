//! Private app storage for recovery snapshots and undo spill files (SPEC §9: files in the app data
//! directory, never database blobs).

use std::fs;
use std::path::{Path, PathBuf};

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

use crate::error::{Error, Result};
use crate::files::write_atomic;

pub struct Storage(pub PathBuf);

/// Keys look like `recovery/<id>.pdf`: relative, forward slashes, no traversal.
pub fn resolve(root: &Path, key: &str) -> Result<PathBuf> {
    let ok = !key.is_empty()
        && key.len() <= 200
        && !key.starts_with('/')
        && key.split('/').all(|part| !part.is_empty() && part != "." && part != ".." && part.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)));
    if ok {
        Ok(root.join(key))
    } else {
        Err(Error::Invalid("invalid storage key".into()))
    }
}

#[tauri::command]
pub fn storage_write(request: Request<'_>, storage: State<'_, Storage>) -> Result<()> {
    let key = request.headers().get("x-folio-key").and_then(|v| v.to_str().ok()).ok_or_else(|| Error::Invalid("missing key".into()))?;
    let path = resolve(&storage.0, key)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    match request.body() {
        InvokeBody::Raw(bytes) => write_atomic(&path, bytes, false),
        InvokeBody::Json(_) => Err(Error::Invalid("expected a binary body".into())),
    }
}

#[tauri::command]
pub fn storage_read(key: String, storage: State<'_, Storage>) -> Result<Response> {
    let path = resolve(&storage.0, &key)?;
    match fs::read(&path) {
        Ok(bytes) => Ok(Response::new(bytes)),
        // An empty body means "no such key" (stored files are never empty).
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Response::new(Vec::new())),
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
pub fn storage_remove(key: String, storage: State<'_, Storage>) -> Result<()> {
    match fs::remove_file(resolve(&storage.0, &key)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub fn list(root: &Path, prefix: &str) -> Vec<String> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        if let Ok(entries) = fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, root, out);
                } else if let Ok(rel) = p.strip_prefix(root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.retain(|k| k.starts_with(prefix) && !k.ends_with(".folio-tmp"));
    out.sort();
    out
}

#[tauri::command]
pub fn storage_list(prefix: String, storage: State<'_, Storage>) -> Vec<String> {
    list(&storage.0, &prefix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_cannot_escape_the_storage_root() {
        let root = Path::new("/data/storage");
        assert_eq!(resolve(root, "recovery/s1.pdf").unwrap(), root.join("recovery/s1.pdf"));
        for bad in ["", "/etc/passwd", "../x", "a/../../x", "a//b", "a/./b", "a b", "recovery\\x"] {
            assert!(resolve(root, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn lists_keys_by_prefix() {
        let dir = tempfile::tempdir().unwrap();
        for key in ["recovery/a.pdf", "recovery/a.json", "history/s/1.pdf"] {
            let p = resolve(dir.path(), key).unwrap();
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, b"x").unwrap();
        }
        assert_eq!(list(dir.path(), "recovery/"), vec!["recovery/a.json", "recovery/a.pdf"]);
        assert_eq!(list(dir.path(), "").len(), 3);
        assert!(list(dir.path(), "nope/").is_empty());
    }
}
