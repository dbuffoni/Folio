//! File I/O commands. Binary data travels as raw IPC bodies, never base64 (SPEC §11.1).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{Error, Result};
use crate::scope::Scope;

#[derive(Serialize, Clone)]
pub struct FileRef {
    pub id: String,
    pub name: String,
    pub path: String,
}

pub fn file_ref(path: &Path) -> FileRef {
    let p = path.to_string_lossy().to_string();
    FileRef {
        id: p.clone(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| p.clone()),
        path: p,
    }
}

/// Where the `.bak` copy of the previous content goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backup<'a> {
    Off,
    /// `<name>.bak` next to the file.
    Beside,
    /// `<name>.<hash>.bak` in a shared folder; the hash of the full path keeps equal names apart.
    Folder(&'a Path),
}

/// What happened to the backup. A failed backup never fails the save; the caller shows a notice.
#[derive(Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
    pub backup_failed: bool,
}

/// FNV-1a over the path bytes, 32 bits as 8 hex digits: stable across releases and platforms.
pub fn short_path_hash(path: &Path) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for b in path.to_string_lossy().as_bytes() {
        h ^= u32::from(*b);
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

/// The backup file for `path`: one per document, overwritten on every save.
pub fn backup_path(path: &Path, backup: Backup<'_>) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy().to_string();
    match backup {
        Backup::Off => None,
        Backup::Beside => Some(path.parent()?.join(format!("{name}.bak"))),
        Backup::Folder(dir) => Some(dir.join(format!("{name}.{}.bak", short_path_hash(path)))),
    }
}

/// Temp file in the same directory + fsync + rename, so a crash never leaves a half-written file.
/// With a `backup`, the previous content is kept as a single `.bak` that each save overwrites.
pub fn write_atomic(path: &Path, data: &[u8], backup: Backup<'_>) -> Result<WriteOutcome> {
    let dir = path
        .parent()
        .ok_or_else(|| Error::Invalid("path has no parent".into()))?;
    let name = path
        .file_name()
        .ok_or_else(|| Error::Invalid("path has no file name".into()))?;
    let mut tmp_name = name.to_os_string();
    tmp_name.push(".folio-tmp");
    let tmp = dir.join(tmp_name);
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    let mut outcome = WriteOutcome::default();
    if path.exists() {
        if let Some(bak) = backup_path(path, backup) {
            if fs::copy(path, bak).is_err() {
                outcome.backup_failed = true;
            }
        }
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    // Make the rename itself durable.
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(outcome)
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Result<&'a str> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| Error::Invalid(format!("missing header {name}")))
}

/// Paths arrive percent-encoded in headers (header values must be ASCII).
fn decode(value: &str) -> Result<PathBuf> {
    let mut out = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                .map_err(|_| Error::Invalid("bad path encoding".into()))?;
            out.push(
                u8::from_str_radix(hex, 16)
                    .map_err(|_| Error::Invalid("bad path encoding".into()))?,
            );
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    Ok(PathBuf::from(
        String::from_utf8(out).map_err(|_| Error::Invalid("bad path encoding".into()))?,
    ))
}

fn body<'a>(request: &'a Request<'_>) -> Result<&'a [u8]> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        InvokeBody::Json(_) => Err(Error::Invalid("expected a binary body".into())),
    }
}

#[tauri::command]
pub fn read_file(path: String, scope: State<'_, Scope>) -> Result<Response> {
    let path = PathBuf::from(path);
    scope.check(&path)?;
    Ok(Response::new(fs::read(&path)?))
}

#[tauri::command]
pub fn write_file_atomic(request: Request<'_>, scope: State<'_, Scope>) -> Result<WriteOutcome> {
    let path = decode(header(&request, "x-folio-path")?)?;
    let want_backup = request
        .headers()
        .get("x-folio-backup")
        .map(|v| v == "1")
        .unwrap_or(false);
    let folder = match request.headers().get("x-folio-backup-dir") {
        Some(v) => Some(decode(v.to_str().map_err(|_| Error::Invalid("bad header".into()))?)?),
        None => None,
    };
    scope.check(&path)?;
    // A backup folder is only honoured when it is the one the user granted; otherwise the save
    // still happens and the caller is told the backup was not made.
    let (backup, denied) = match (&folder, want_backup) {
        (_, false) => (Backup::Off, false),
        (None, true) => (Backup::Beside, false),
        (Some(dir), true) if scope.allows_backup_folder(dir) => (Backup::Folder(dir), false),
        (Some(_), true) => (Backup::Off, true),
    };
    let mut outcome = write_atomic(&path, body(&request)?, backup)?;
    outcome.backup_failed |= denied;
    Ok(outcome)
}

/// Makes the folder just picked in a dialog the persistent backup folder; `None` clears it.
#[tauri::command]
pub fn set_backup_folder(path: Option<String>, scope: State<'_, Scope>) -> Result<()> {
    match path {
        None => scope.set_backup_folder(None),
        Some(p) => {
            let p = PathBuf::from(p);
            if !scope.allows_folder(&p) && !scope.allows_backup_folder(&p) {
                return Err(Error::NotGranted);
            }
            scope.set_backup_folder(Some(&p));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn write_in_folder(request: Request<'_>, scope: State<'_, Scope>) -> Result<FileRef> {
    let dir = decode(header(&request, "x-folio-dir")?)?;
    let name = decode(header(&request, "x-folio-name")?)?;
    let name = name.to_string_lossy().to_string();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err(Error::Invalid("invalid file name".into()));
    }
    if !scope.allows_folder(&dir) {
        return Err(Error::NotGranted);
    }
    let path = dir.join(&name);
    write_atomic(&path, body(&request)?, Backup::Off)?;
    scope.grant_file(&path);
    Ok(file_ref(&path))
}

#[tauri::command]
pub fn file_exists(dir: String, name: String, scope: State<'_, Scope>) -> Result<bool> {
    let dir = PathBuf::from(dir);
    if !scope.allows_folder(&dir) {
        return Err(Error::NotGranted);
    }
    Ok(dir.join(name).exists())
}

/// True when a previously granted file is still there (recent files: "File not found").
#[tauri::command]
pub fn path_exists(path: String, scope: State<'_, Scope>) -> bool {
    let path = PathBuf::from(path);
    scope.allows(&path) && path.exists()
}

/// The folder containing a granted file, granted for the session so split/export can default to it.
#[tauri::command]
pub fn parent_of(path: String, scope: State<'_, Scope>) -> Result<Option<FileRef>> {
    let path = PathBuf::from(path);
    scope.check(&path)?;
    Ok(path.parent().map(|dir| {
        scope.grant_folder(dir);
        file_ref(dir)
    }))
}

/// Re-grants a path from an earlier session (recent files). Unknown paths are refused.
#[tauri::command]
pub fn grant_path(path: String, scope: State<'_, Scope>) -> bool {
    scope.allows(Path::new(&path))
}

#[tauri::command]
pub fn forget_path(path: String, scope: State<'_, Scope>) {
    scope.revoke_file(Path::new(&path));
}

#[tauri::command]
pub fn reveal_in_folder(app: AppHandle, path: String, scope: State<'_, Scope>) -> Result<()> {
    scope.check(Path::new(&path))?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| Error::Io(e.to_string()))
}

/// Printing fallback: hand a granted file to the system PDF viewer.
#[tauri::command]
pub fn open_in_system_viewer(app: AppHandle, path: String, scope: State<'_, Scope>) -> Result<()> {
    scope.check(Path::new(&path))?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| Error::Io(e.to_string()))
}

fn filters(kinds: &[String]) -> Vec<(&'static str, Vec<&'static str>)> {
    let mut out = Vec::new();
    for k in kinds {
        match k.as_str() {
            "pdf" => out.push(("PDF documents", vec!["pdf"])),
            "image" => out.push(("Images", vec!["png", "jpg", "jpeg", "webp", "tif", "tiff"])),
            "json" => out.push(("JSON files", vec!["json"])),
            "zip" => out.push(("ZIP archives", vec!["zip"])),
            "csv" => out.push(("CSV files", vec!["csv"])),
            "pkcs12" => out.push(("Certificate files with a private key", vec!["p12", "pfx"])),
            "certificate" => out.push(("Certificates", vec!["cer", "crt", "pem", "der"])),
            _ => {}
        }
    }
    out
}

#[tauri::command]
pub async fn pick_open(
    app: AppHandle,
    multiple: bool,
    accept: Vec<String>,
) -> Result<Vec<FileRef>> {
    let mut dialog = app.dialog().file();
    let all: Vec<&str> = filters(&accept)
        .iter()
        .flat_map(|(_, e)| e.clone())
        .collect();
    if accept.len() > 1 && !all.is_empty() {
        dialog = dialog.add_filter("Supported files", &all);
    }
    for (name, exts) in filters(&accept) {
        dialog = dialog.add_filter(name, &exts);
    }
    let picked = if multiple {
        dialog.blocking_pick_files().unwrap_or_default()
    } else {
        dialog.blocking_pick_file().into_iter().collect()
    };
    let scope = app.state::<Scope>();
    let mut refs = Vec::new();
    for item in picked {
        if let Ok(path) = item.into_path() {
            scope.grant_file(&path);
            refs.push(file_ref(&path));
        }
    }
    Ok(refs)
}

#[tauri::command]
pub async fn pick_save(
    app: AppHandle,
    suggested_name: String,
    kind: String,
    directory: Option<String>,
) -> Result<Option<FileRef>> {
    let mut dialog = app.dialog().file().set_file_name(&suggested_name);
    if let Some(dir) = directory {
        dialog = dialog.set_directory(dir);
    }
    for (name, exts) in filters(&[kind]) {
        dialog = dialog.add_filter(name, &exts);
    }
    let scope = app.state::<Scope>();
    Ok(dialog
        .blocking_save_file()
        .and_then(|p| p.into_path().ok())
        .map(|path| {
            scope.grant_file(&path);
            file_ref(&path)
        }))
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<FileRef>> {
    let scope = app.state::<Scope>();
    Ok(app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|path| {
            scope.grant_folder(&path);
            file_ref(&path)
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_content_and_keeps_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.pdf");
        write_atomic(&path, b"first", Backup::Beside).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"first");
        assert!(!dir.path().join("doc.pdf.bak").exists());
        write_atomic(&path, b"second", Backup::Beside).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert_eq!(fs::read(dir.path().join("doc.pdf.bak")).unwrap(), b"first");
        write_atomic(&path, b"third", Backup::Off).unwrap();
        assert_eq!(fs::read(dir.path().join("doc.pdf.bak")).unwrap(), b"first");
        assert!(!dir.path().join("doc.pdf.folio-tmp").exists());
    }

    #[test]
    fn shared_folder_keeps_one_bak_per_file_named_with_a_path_hash() {
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join("backups");
        fs::create_dir(&shared).unwrap();
        let a = dir.path().join("x").join("doc.pdf");
        let b = dir.path().join("y").join("doc.pdf");
        fs::create_dir(a.parent().unwrap()).unwrap();
        fs::create_dir(b.parent().unwrap()).unwrap();
        for (p, v) in [(&a, "a"), (&b, "b")] {
            write_atomic(p, v.as_bytes(), Backup::Folder(&shared)).unwrap();
            write_atomic(p, format!("{v}2").as_bytes(), Backup::Folder(&shared)).unwrap();
            write_atomic(p, format!("{v}3").as_bytes(), Backup::Folder(&shared)).unwrap();
        }
        let baks = |p: &Path| backup_path(p, Backup::Folder(&shared)).unwrap();
        assert_ne!(baks(&a), baks(&b));
        assert!(baks(&a)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("doc.pdf."));
        // Overwritten on every save: only the previous version is kept.
        assert_eq!(fs::read(baks(&a)).unwrap(), b"a2");
        assert_eq!(fs::read(baks(&b)).unwrap(), b"b2");
        assert_eq!(fs::read_dir(&shared).unwrap().count(), 2);
        assert!(!a.parent().unwrap().join("doc.pdf.bak").exists());
    }

    #[test]
    fn path_hash_is_stable() {
        assert_eq!(short_path_hash(Path::new("/docs/a.pdf")), short_path_hash(Path::new("/docs/a.pdf")));
        assert_eq!(short_path_hash(Path::new("")), "811c9dc5");
        assert_ne!(short_path_hash(Path::new("/a/doc.pdf")), short_path_hash(Path::new("/b/doc.pdf")));
    }

    #[test]
    fn a_missing_backup_folder_does_not_fail_the_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.pdf");
        write_atomic(&path, b"one", Backup::Off).unwrap();
        let gone = dir.path().join("gone");
        let out = write_atomic(&path, b"two", Backup::Folder(&gone)).unwrap();
        assert!(out.backup_failed);
        assert_eq!(fs::read(&path).unwrap(), b"two");
        let ok = write_atomic(&path, b"three", Backup::Beside).unwrap();
        assert!(!ok.backup_failed);
    }

    #[test]
    fn failed_write_leaves_the_original_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing-dir").join("doc.pdf");
        assert!(write_atomic(&path, b"x", Backup::Off).is_err());
        let target = dir.path().join("target");
        fs::create_dir(&target).unwrap();
        // Renaming a file over a directory fails: the temp file must be cleaned up.
        assert!(write_atomic(&target, b"x", Backup::Off).is_err());
        assert!(target.is_dir());
        assert!(!dir.path().join("target.folio-tmp").exists());
    }

    #[test]
    fn decodes_percent_encoded_paths() {
        assert_eq!(
            decode("/tmp/a%20b/%C3%A9.pdf").unwrap(),
            PathBuf::from("/tmp/a b/é.pdf")
        );
        assert!(decode("%zz").is_err());
    }
}
