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
    let Some(rest) = arg.strip_prefix("file://") else {
        return arg;
    };
    let bytes = rest.as_bytes();
    let drive =
        bytes.len() >= 4 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':';
    if drive {
        &rest[1..]
    } else {
        rest
    }
}

/// Existing files among the URLs the OS hands over (macOS "Open with" and Finder double-clicks).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn paths_from_urls(urls: &[url::Url]) -> Vec<PathBuf> {
    urls.iter()
        .filter_map(|u| u.to_file_path().ok())
        .filter(|p| p.is_file())
        .collect()
}

/// A window rectangle in logical pixels (origin top-left of the virtual desktop).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Room kept inside the work area: the outer size includes title bar and borders on some platforms and
/// not on others (X11 frames), so the window never fills the area completely.
const MARGIN_W: f64 = 16.0;
const MARGIN_H: f64 = 40.0;

/// Fits a window into the monitor's work area (the screen without task bar and dock): shrinks it so the
/// bottom border and status bar stay visible, then moves it inside. A saved size larger than the current
/// screen is clamped by the same rule; a window that already fits is left where it is.
pub fn fit_rect(window: Rect, work: Rect) -> Rect {
    let w = window.w.min((work.w - MARGIN_W).max(1.0)).floor();
    let h = window.h.min((work.h - MARGIN_H).max(1.0)).floor();
    let max_x = work.x + work.w - w;
    let max_y = work.y + work.h - h;
    Rect {
        x: window.x.max(work.x).min(max_x).round(),
        y: window.y.max(work.y).min(max_y).round(),
        w,
        h,
    }
}

/// The smallest size the window may be given on this screen: the configured minimum, never above what fits.
pub fn fit_minimum(min: (f64, f64), work: Rect) -> (f64, f64) {
    (
        min.0.min((work.w - MARGIN_W).max(1.0)).floor(),
        min.1.min((work.h - MARGIN_H).max(1.0)).floor(),
    )
}

/// Applies the saved size and position (if any), then fits the window into the work area of the monitor
/// it is on. First run: the configured default (about an A4 page plus the panes) shrunk to the screen.
fn place_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // Restoring is explicit (`skip_initial_state` below) so the fit always runs after it.
    let _ = tauri_plugin_window_state::WindowExt::restore_state(
        &window,
        tauri_plugin_window_state::StateFlags::SIZE | tauri_plugin_window_state::StateFlags::POSITION,
    );
    let (Ok(Some(monitor)), Ok(size), Ok(pos)) = (
        window.current_monitor(),
        window.outer_size(),
        window.outer_position(),
    ) else {
        return;
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let work = {
        let p = area.position.to_logical::<f64>(scale);
        let s = area.size.to_logical::<f64>(scale);
        Rect { x: p.x, y: p.y, w: s.width, h: s.height }
    };
    let (p, s) = (pos.to_logical::<f64>(scale), size.to_logical::<f64>(scale));
    let current = Rect { x: p.x, y: p.y, w: s.width, h: s.height };
    let fitted = fit_rect(current, work);
    let (min_w, min_h) = fit_minimum((900.0, 560.0), work);
    let _ = window.set_min_size(Some(tauri::LogicalSize::new(min_w, min_h)));
    if fitted != current {
        let _ = window.set_size(tauri::LogicalSize::new(fitted.w, fitted.h));
        let _ = window.set_position(tauri::LogicalPosition::new(fitted.x, fitted.y));
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
        .find_map(|k| {
            std::env::var(k)
                .ok()
                .filter(|v| !v.is_empty() && v != "C" && v != "POSIX")
        })
        .map(|v| v.split('.').next().unwrap_or("en").replace('_', "-"))
        .unwrap_or_else(|| "en".into());
    AppInfo {
        version: app.package_info().version.to_string(),
        os: if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        },
        locale,
        user_name: std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .ok()
            .filter(|u| !u.is_empty()),
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
fn wipe_app_data(
    scope: State<'_, Scope>,
    storage: State<'_, storage::Storage>,
    secrets: State<'_, secrets::Secrets>,
    db: State<'_, db::Db>,
) -> error::Result<()> {
    scope.revoke_all();
    let _ = std::fs::remove_dir_all(&storage.0);
    secrets::wipe(secrets.0.as_ref(), &db)
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
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(1_000_000)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .skip_initial_state("main")
                .build(),
        )
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
            app.manage(http::ApprovedNetworkHosts::default());
            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().to_string());
            let refs = accept_paths(app.handle(), paths_from_args(&args, cwd.as_deref()));
            app.manage(PendingOpen(Mutex::new(refs), Default::default()));
            place_window(app.handle());
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
            http::download_file,
            http::binary_request,
            db::db_execute,
            db::db_select,
            storage::storage_write,
            storage::storage_read,
            storage::storage_remove,
            storage::storage_list,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Folio")
        .run(|app, event| {
            // macOS delivers "Open with" and Finder double-clicks as an event, not as arguments.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                let refs = accept_paths(app, paths_from_urls(&urls));
                if refs.is_empty() {
                    return;
                }
                // Before the frontend asked for its pending files they are queued; afterwards, emitted.
                let pending = app.state::<PendingOpen>();
                if pending.1.load(std::sync::atomic::Ordering::SeqCst) {
                    let _ = app.emit("folio://open", refs);
                } else {
                    pending.0.lock().unwrap().extend(refs);
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
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

    fn work(w: f64, h: f64) -> Rect {
        Rect { x: 0.0, y: 0.0, w, h }
    }

    #[test]
    fn the_window_never_exceeds_the_screen() {
        // 1366x768 laptop with a task bar: 1366x728 work area; the 1100x780 default loses height.
        let r = fit_rect(Rect { x: 100.0, y: 80.0, w: 1100.0, h: 780.0 }, work(1366.0, 728.0));
        assert_eq!((r.w, r.h), (1100.0, 688.0));
        assert!(r.y + r.h <= 728.0, "bottom border stays visible");
        // Large screen: untouched.
        let big = Rect { x: 200.0, y: 100.0, w: 1100.0, h: 780.0 };
        assert_eq!(fit_rect(big, work(2560.0, 1400.0)), big);
    }

    #[test]
    fn a_saved_size_larger_than_the_screen_is_clamped() {
        let r = fit_rect(Rect { x: -300.0, y: -50.0, w: 3000.0, h: 2000.0 }, work(1920.0, 1040.0));
        assert_eq!(r, Rect { x: 0.0, y: 0.0, w: 1904.0, h: 1000.0 });
    }

    #[test]
    fn a_window_saved_on_a_removed_monitor_comes_back_inside() {
        let r = fit_rect(Rect { x: 2400.0, y: 900.0, w: 1100.0, h: 780.0 }, work(1920.0, 1040.0));
        assert_eq!((r.x, r.y), (820.0, 260.0));
        // Work area that does not start at the origin (second monitor, top bar).
        let area = Rect { x: 1920.0, y: 30.0, w: 1280.0, h: 690.0 };
        let r = fit_rect(Rect { x: 100.0, y: 100.0, w: 1100.0, h: 780.0 }, area);
        assert_eq!((r.x, r.y, r.h), (1920.0, 70.0, 650.0));
    }

    #[test]
    fn the_minimum_size_follows_small_screens() {
        assert_eq!(fit_minimum((900.0, 560.0), work(1366.0, 728.0)), (900.0, 560.0));
        assert_eq!(fit_minimum((900.0, 560.0), work(800.0, 500.0)), (784.0, 460.0));
    }

    #[test]
    fn open_urls_keep_only_existing_local_files() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.pdf");
        std::fs::write(&a, b"x").unwrap();
        let urls = vec![
            url::Url::from_file_path(&a).unwrap(),
            url::Url::from_file_path(dir.path().join("missing.pdf")).unwrap(),
            url::Url::parse("https://example.com/a.pdf").unwrap(),
        ];
        assert_eq!(paths_from_urls(&urls), vec![a]);
    }

    #[test]
    fn file_uris_lose_their_scheme_and_windows_drive_slash() {
        assert_eq!(path_from_uri("file:///home/a.pdf"), "/home/a.pdf");
        assert_eq!(path_from_uri("file:///C:/Users/a.pdf"), "C:/Users/a.pdf");
        assert_eq!(path_from_uri("C:\\a.pdf"), "C:\\a.pdf");
    }
}
