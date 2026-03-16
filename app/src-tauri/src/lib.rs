mod history;
mod selection;

use history::{Database, HistoryItem};
use selection::{read_clipboard, simulate_copy, start_listener, SelectionSignal};

use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, State, WebviewWindow,
};

// ── Shared app state ──────────────────────────────────────────────────────────

pub struct AppState {
    pub db: Arc<Mutex<Database>>,
    pub watcher_enabled: Arc<Mutex<bool>>,
    /// Timestamp of the last manual copy_item call.
    /// The processor ignores SelectionSignals that arrive within 1 s of this.
    pub last_manual_copy: Arc<Mutex<Instant>>,
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn get_history(state: State<Arc<AppState>>) -> Vec<HistoryItem> {
    state
        .db
        .lock()
        .map(|db| db.get_all().unwrap_or_default())
        .unwrap_or_default()
}

#[tauri::command]
fn copy_item(id: i64, state: State<Arc<AppState>>) -> bool {
    let text = {
        let db = state.db.lock().unwrap();
        db.get_all()
            .unwrap_or_default()
            .into_iter()
            .find(|i| i.id == id)
            .map(|i| i.content)
    };

    if let Some(t) = text {
        // Mark the time so the selection processor ignores the click that triggered this
        *state.last_manual_copy.lock().unwrap() = Instant::now();
        use arboard::Clipboard;
        if let Ok(mut clip) = Clipboard::new() {
            clip.set_text(t.as_str()).is_ok()
        } else {
            false
        }
    } else {
        false
    }
}

#[tauri::command]
fn delete_item(id: i64, state: State<Arc<AppState>>) -> bool {
    state
        .db
        .lock()
        .map(|mut db| db.delete(id).is_ok())
        .unwrap_or(false)
}

#[tauri::command]
fn clear_history(state: State<Arc<AppState>>) -> bool {
    state
        .db
        .lock()
        .map(|mut db| db.clear_all().is_ok())
        .unwrap_or(false)
}

#[tauri::command]
fn get_watcher_status(state: State<Arc<AppState>>) -> bool {
    *state.watcher_enabled.lock().unwrap_or_else(|e| e.into_inner())
}

#[tauri::command]
fn check_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "ApplicationServices", kind = "framework")]
        extern "C" { fn AXIsProcessTrusted() -> bool; }
        unsafe { AXIsProcessTrusted() }
    }
    #[cfg(not(target_os = "macos"))]
    { true }
}

#[tauri::command]
fn check_input_monitoring() -> bool {
    #[cfg(target_os = "macos")]
    {
        // IOHIDCheckAccess(kIOHIDRequestTypeListenForNewDevices=1)
        // returns kIOHIDAccessTypeGranted=0 when permission is granted.
        #[link(name = "IOKit", kind = "framework")]
        extern "C" { fn IOHIDCheckAccess(request_type: u32) -> i32; }
        unsafe { IOHIDCheckAccess(1) == 0 }
    }
    #[cfg(not(target_os = "macos"))]
    { true }
}

#[tauri::command]
fn open_accessibility_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn();
    }
}

#[tauri::command]
fn open_input_monitoring_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
            .spawn();
    }
}

#[tauri::command]
fn set_watcher_enabled(enabled: bool, state: State<Arc<AppState>>) {
    *state.watcher_enabled.lock().unwrap() = enabled;
}

// ── Window helpers ─────────────────────────────────────────────────────────────

fn toggle_history_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("history") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_history_window(&window);
        }
    }
}

fn show_history_window<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.center();
    let _ = window.show();
    let _ = window.set_focus();
}

// ── Background processing loop ─────────────────────────────────────────────────

fn start_copy_processor(
    rx: mpsc::Receiver<SelectionSignal>,
    state: Arc<AppState>,
    app_handle: AppHandle,
) {
    thread::spawn(move || {
        for SelectionSignal in rx {
            // Skip if watcher is disabled
            if !*state.watcher_enabled.lock().unwrap_or_else(|e| e.into_inner()) {
                continue;
            }

            // Skip if the history overlay is the focused window
            if let Some(win) = app_handle.get_webview_window("history") {
                if win.is_focused().unwrap_or(false) {
                    continue;
                }
            }

            // Skip if a manual copy_item was triggered within the last second —
            // the click that fired copy_item also triggers a SelectionSignal and
            // would otherwise re-save the just-pasted item.
            {
                let last = *state.last_manual_copy.lock().unwrap();
                if last.elapsed() < Duration::from_millis(1000) {
                    eprintln!("[pluks] suppressing signal (manual copy was {}ms ago)", last.elapsed().as_millis());
                    continue;
                }
            }

            // Snapshot clipboard before simulating copy
            let before = read_clipboard();

            // Give the OS time to finalise the selection before we send Cmd+C
            thread::sleep(Duration::from_millis(80));

            // Simulate Cmd+C
            eprintln!("[pluks] simulating copy...");
            simulate_copy();

            // Wait for the target app to write to the clipboard
            thread::sleep(Duration::from_millis(150));

            let after = read_clipboard();
            eprintln!("[pluks] before={:?} after={:?}", before.as_deref().map(|s| &s[..s.len().min(30)]), after.as_deref().map(|s| &s[..s.len().min(30)]));

            if let Some(text) = after {
                // Only save if the clipboard actually changed
                if before.as_deref() != Some(&text) {
                    if let Ok(mut db) = state.db.lock() {
                        if let Ok(item) = db.insert(&text) {
                            let _ = app_handle.emit("new-selection", &item);
                        }
                    }
                }
            }
        }
    });
}

// ── App entry point ────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // ── macOS: hide dock icon (run as accessory/agent) ────────────
            #[cfg(target_os = "macos")]
            {
                use tauri::ActivationPolicy;
                app.set_activation_policy(ActivationPolicy::Accessory);
            }

            // ── Enable login-item autostart (silent, idempotent) ─────────
            {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }

            // ── Initialise database ──────────────────────────────────────
            let db_path = app
                .path()
                .app_data_dir()
                .expect("app data dir unavailable")
                .join("pluck.db");

            let db = Database::new(db_path).expect("failed to open database");
            let state = Arc::new(AppState {
                db: Arc::new(Mutex::new(db)),
                watcher_enabled: Arc::new(Mutex::new(true)),
                last_manual_copy: Arc::new(Mutex::new(Instant::now() - Duration::from_secs(60))),
            });
            app.manage(state.clone());

            // ── System tray ──────────────────────────────────────────────
            let toggle_item =
                MenuItem::with_id(app, "toggle", "Disable Auto-Copy", true, None::<&str>)?;
            let history_item =
                MenuItem::with_id(app, "history", "Show History (⇧⌃V)", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Pluck", true, None::<&str>)?;

            let menu = Menu::with_items(app, &[&toggle_item, &history_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Pluck — select to copy")
                .on_menu_event({
                    let app_handle = app.handle().clone();
                    let state_ref = state.clone();
                    move |_tray, event| match event.id().as_ref() {
                        "toggle" => {
                            let mut enabled = state_ref.watcher_enabled.lock().unwrap();
                            *enabled = !*enabled;
                        }
                        "history" => {
                            toggle_history_window(&app_handle);
                        }
                        "quit" => {
                            app_handle.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    // Left-click on tray also opens history
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_history_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // ── Global shortcut: CmdOrCtrl+Shift+V ──────────────────────
            {
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
                let shortcut: Shortcut = "CmdOrCtrl+Shift+V".parse().unwrap();
                let app_handle = app.handle().clone();
                app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, _event| {
                    toggle_history_window(&app_handle);
                })?;
            }

            // ── Selection watcher ────────────────────────────────────────
            let (tx, rx) = mpsc::channel::<SelectionSignal>();
            start_listener(tx);
            start_copy_processor(rx, state, app.handle().clone());

            // ── Hide history window when it loses focus ──────────────────
            if let Some(win) = app.get_webview_window("history") {
                win.on_window_event(|event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        // Note: we can't hide here directly because we don't own the window handle.
                        // The React frontend listens for blur and calls hide via invoke.
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_history,
            copy_item,
            delete_item,
            clear_history,
            get_watcher_status,
            set_watcher_enabled,
            check_accessibility,
            check_input_monitoring,
            open_accessibility_settings,
            open_input_monitoring_settings,
        ])
        .on_window_event(|window, event| {
            // Prevent the history window from fully closing; just hide it
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "history" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Pluck");
}
