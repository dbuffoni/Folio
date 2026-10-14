//! Folio desktop shell. Rust does only what a web runtime cannot (SPEC §11): file I/O with a
//! dynamic scope, secrets, the AI HTTP proxy, the local database, and OS integration.

mod db;
mod error;
mod files;
mod http;
mod scope;
mod secrets;
mod storage;

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

use crate::scope::Scope;

/// Files handed over by the OS before the frontend was ready (CLI arguments, "Open with").
#[derive(Default)]
struct PendingOpen(Mutex<Vec<files::FileRef>>, std::sync::atomic::AtomicBool);

/// `file:///C:/x.pdf` → `C:/x.pdf` on Windows, `file:///x.pdf` → `/x.pdf` elsewhere.
fn path_from_uri(arg: &str) -> &str {
    let Some(rest) = arg.strip_prefix("file://") else { return arg };
    let bytes = rest.as_bytes();
    let drive = bytes.len() >= 4 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':';
    if drive {
        &rest[1..]
    } else {
        rest
    }
}

/// Paths among launch arguments that look like documents; flags are ignored.
pub fn paths_from_args(args: &[String], cwd: Option<&str>) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(path_from_uri(a));
            match (p.is_absolute(), cwd) {
                (false, Some(dir)) => PathBuf::from(dir).join(p),
                _ => p,
            }
        })
        .filter(|p| p.is_file())
        .collect()
}

fn accept_paths(app: &AppHandle, paths: Vec<PathBuf>) -> Vec<files::FileRef> {
    let scope = app.state::<Scope>();
    paths
        .iter()
        .map(|p| {
            scope.grant_file(p);
            files::file_ref(p)
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    os: &'static str,
    locale: String,
    user_name: Option<String>,
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty() && v != "C" && v != "POSIX"))
        .map(|v| v.split('.').next().unwrap_or("en").replace('_', "-"))
        .unwrap_or_else(|| "en".into());
    AppInfo {
        version: app.package_info().version.to_string(),
        os: if cfg!(target_os = "windows") { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" },
        locale,
        user_name: std::env::var("USER").or_else(|_| std::env::var("USERNAME")).ok().filter(|u| !u.is_empty()),
    }
}

#[tauri::command]
fn take_pending_open_paths(pending: State<'_, PendingOpen>) -> Vec<files::FileRef> {
    // From here on the frontend is listening, so later files are emitted instead of queued.
    pending.1.store(true, std::sync::atomic::Ordering::SeqCst);
    std::mem::take(&mut *pending.0.lock().unwrap())
}

/// "Delete all app data": database, recovery files, granted paths and stored secrets.
#[tauri::command]
fn wipe_app_data(scope: State<'_, Scope>, storage: State<'_, storage::Storage>, secrets: State<'_, secrets::Secrets>) -> error::Result<()> {
    scope.revoke_all();
    let _ = std::fs::remove_dir_all(&storage.0);
    for key in [http::AI_KEY, "folio.data-key"] {
        secrets.0.remove(key)?;
    }
    Ok(())
}

#[tauri::command]
fn exit_app(app: AppHandle, code: i32) {
    app.exit(code);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // A second launch forwards its files to the running window.
            let refs = accept_paths(app, paths_from_args(&args, Some(&cwd)));
            if !refs.is_empty() {
                let _ = app.emit("folio://open", refs);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_log::Builder::new().level(log::LevelFilter::Info).max_file_size(1_000_000).build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            let config = app.path().app_config_dir()?;
            app.manage(Scope::new(Some(data.join("grants.json"))));
            app.manage(storage::Storage(data.join("storage")));
            app.manage(db::Db::open(&data.join("folio.sqlite3"))?);
            app.manage(secrets::Secrets::detect());
            app.manage(http::AllowedOrigin::new(Some(config.join("ai-origin"))));
            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().to_string());
            let refs = accept_paths(app.handle(), paths_from_args(&args, cwd.as_deref()));
            app.manage(PendingOpen(Mutex::new(refs), Default::default()));
            Ok(())
        })
        .on_window_event(|window, event| {
            // Files dropped on the window are granted here, then announced to the frontend.
            if let WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let files: Vec<PathBuf> = paths.iter().filter(|p| p.is_file()).cloned().collect();
                let refs = accept_paths(window.app_handle(), files);
                if !refs.is_empty() {
                    let _ = window.emit("folio://drop", refs);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            take_pending_open_paths,
            wipe_app_data,
            exit_app,
            files::read_file,
            files::write_file_atomic,
            files::write_in_folder,
            files::file_exists,
            files::path_exists,
            files::parent_of,
            files::grant_path,
            files::forget_path,
            files::reveal_in_folder,
            files::open_in_system_viewer,
            files::pick_open,
            files::pick_save,
            files::pick_folder,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_remove,
            secrets::secret_backend,
            http::ai_origin,
            http::set_ai_origin,
            http::http_request,
            db::db_execute,
            db::db_select,
            storage::storage_write,
            storage::storage_read,
            storage::storage_remove,
            storage::storage_list,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Folio")
        .run(|_app, _event| {
            // macOS delivers "Open with" and Finder double-clicks as an event, not as arguments.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let paths: Vec<PathBuf> = urls.iter().filter_map(|u| u.to_file_path().ok()).filter(|p| p.is_file()).collect();
                let refs = accept_paths(_app, paths);
                if refs.is_empty() {
                    return;
                }
                // Before the frontend asked for its pending files they are queued; afterwards, emitted.
                let pending = _app.state::<PendingOpen>();
                if pending.1.load(std::sync::atomic::Ordering::SeqCst) {
                    let _ = _app.emit("folio://open", refs);
                } else {
                    pending.0.lock().unwrap().extend(refs);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_arguments_become_paths() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.pdf");
        std::fs::write(&a, b"x").unwrap();
        let args = vec![
            "folio".to_string(),
            "--flag".to_string(),
            a.to_string_lossy().to_string(),
            "a.pdf".to_string(),
            format!("file://{}", a.to_string_lossy()),
            "missing.pdf".to_string(),
        ];
        let got = paths_from_args(&args, Some(&dir.path().to_string_lossy()));
        assert_eq!(got, vec![a.clone(), a.clone(), a]);
        assert!(paths_from_args(&["folio".to_string()], None).is_empty());
    }

    #[test]
    fn file_uris_lose_their_scheme_and_windows_drive_slash() {
        assert_eq!(path_from_uri("file:///home/a.pdf"), "/home/a.pdf");
        assert_eq!(path_from_uri("file:///C:/Users/a.pdf"), "C:/Users/a.pdf");
        assert_eq!(path_from_uri("C:\\a.pdf"), "C:\\a.pdf");
    }
}
