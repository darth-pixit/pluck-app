mod history;
mod selection;

use history::{Database, HistoryItem};
use selection::{read_clipboard, simulate_copy, simulate_paste, start_listener, SelectionSignal};

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
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn get_history(state: State<Arc<AppState>>) -> Vec<HistoryItem> {
    state.db.lock().map(|db| db.get_all().unwrap_or_default()).unwrap_or_default()
}

#[tauri::command]
fn copy_item(id: i64, state: State<Arc<AppState>>) -> bool {
    let text = {
        let db = state.db.lock().unwrap();
        db.get_all().unwrap_or_default().into_iter().find(|i| i.id == id).map(|i| i.content)
    };
    if let Some(t) = text {
        use arboard::Clipboard;
        if let Ok(mut clip) = Clipboard::new() { clip.set_text(t.as_str()).is_ok() } else { false }
    } else { false }
}

#[tauri::command]
fn delete_item(id: i64, state: State<Arc<AppState>>) -> bool {
    state.db.lock().map(|mut db| db.delete(id).is_ok()).unwrap_or(false)
}

#[tauri::command]
fn clear_history(state: State<Arc<AppState>>) -> bool {
    state.db.lock().map(|mut db| db.clear_all().is_ok()).unwrap_or(false)
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
    { let _ = std::process::Command::new("open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility").spawn(); }
}

#[tauri::command]
fn open_input_monitoring_settings() {
    #[cfg(target_os = "macos")]
    { let _ = std::process::Command::new("open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent").spawn(); }
}

#[tauri::command]
fn hide_window(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("history") { let _ = win.hide(); }
}

#[tauri::command]
fn minimize_window(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("history") { let _ = win.minimize(); }
}

#[tauri::command]
fn set_watcher_enabled(enabled: bool, state: State<Arc<AppState>>) {
    *state.watcher_enabled.lock().unwrap() = enabled;
}

/// Called by the frontend after hiding the panel to paste into the previous app.
#[tauri::command]
fn invoke_paste() { simulate_paste(); }

// ── Window helpers ─────────────────────────────────────────────────────────────

fn show_history_window<R: Runtime>(window: &WebviewWindow<R>, keyboard: bool) {
    let _ = window.center();
    let _ = window.show();
    let _ = window.set_focus();
    if keyboard {
        let _ = window.emit("keyboard-open", ());
    }
}

fn toggle_history_window<R: Runtime>(app: &AppHandle<R>, keyboard: bool) {
    if let Some(win) = app.get_webview_window("history") {
        if win.is_visible().unwrap_or(false) {
            if keyboard {
                // Panel already open — just activate keyboard mode, don't close it
                let _ = win.set_focus();
                let _ = win.emit("keyboard-open", ());
            } else {
                let _ = win.hide();
            }
        } else {
            show_history_window(&win, keyboard);
        }
    }
}

// ── Background processing loop ─────────────────────────────────────────────────

fn start_copy_processor(rx: mpsc::Receiver<SelectionSignal>, state: Arc<AppState>, app_handle: AppHandle) {
    thread::spawn(move || {
        for SelectionSignal in rx {
            if !*state.watcher_enabled.lock().unwrap_or_else(|e| e.into_inner()) { continue; }

            if let Some(win) = app_handle.get_webview_window("history") {
                // Skip if the panel is currently visible (user is interacting with it)
                if win.is_visible().unwrap_or(false) { continue; }
            }

            let before = read_clipboard();
            thread::sleep(Duration::from_millis(80));
            eprintln!("[pluks] simulating copy...");
            simulate_copy();

            // Adaptive wait: poll until clipboard changes or 600 ms elapses
            let after = {
                let deadline = Instant::now() + Duration::from_millis(600);
                let mut latest = read_clipboard();
                loop {
                    thread::sleep(Duration::from_millis(25));
                    latest = read_clipboard();
                    if latest.as_deref() != before.as_deref() { break; }
                    if Instant::now() >= deadline { break; }
                }
                latest
            };

            eprintln!("[pluks] before={:?} after={:?}",
                before.as_deref().map(|s| &s[..s.len().min(30)]),
                after.as_deref().map(|s| &s[..s.len().min(30)]));

            if let Some(text) = after {
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
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![])))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            { use tauri::ActivationPolicy; app.set_activation_policy(ActivationPolicy::Accessory); }

            { use tauri_plugin_autostart::ManagerExt; let _ = app.autolaunch().enable(); }

            let db_path = app.path().app_data_dir().expect("no app data dir").join("pluck.db");
            let db = Database::new(db_path).expect("failed to open database");
            let state = Arc::new(AppState {
                db: Arc::new(Mutex::new(db)),
                watcher_enabled: Arc::new(Mutex::new(true)),
            });
            app.manage(state.clone());

            // ── Tray ─────────────────────────────────────────────────────
            let toggle_item = MenuItem::with_id(app, "toggle", "Disable Auto-Copy", true, None::<&str>)?;
            let history_item = MenuItem::with_id(app, "history", "Show History (⌘⇧V)", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Pluks", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle_item, &history_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .menu_on_left_click(false)   // left-click opens panel; right-click shows menu
                .tooltip("Pluks — select to copy")
                .on_menu_event({
                    let app_handle = app.handle().clone();
                    let state_ref = state.clone();
                    move |_tray, event| match event.id().as_ref() {
                        "toggle" => { let mut e = state_ref.watcher_enabled.lock().unwrap(); *e = !*e; }
                        "history" => { toggle_history_window(&app_handle, false); }
                        "quit" => { app_handle.exit(0); }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    // Left-click opens the history panel directly
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        toggle_history_window(tray.app_handle(), false);
                    }
                })
                .build(app)?;

            // ── Global shortcut ──────────────────────────────────────────
            {
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
                let shortcut: Shortcut = "CmdOrCtrl+Shift+V".parse().unwrap();
                let app_handle = app.handle().clone();
                app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, _event| {
                    // Pass keyboard=true so the frontend enters keyboard-navigation mode
                    toggle_history_window(&app_handle, true);
                })?;
            }

            let (tx, rx) = mpsc::channel::<SelectionSignal>();
            start_listener(tx);
            start_copy_processor(rx, state, app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_history, copy_item, delete_item, clear_history,
            get_watcher_status, set_watcher_enabled,
            check_accessibility, check_input_monitoring,
            open_accessibility_settings, open_input_monitoring_settings,
            hide_window, minimize_window, invoke_paste,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "history" { api.prevent_close(); let _ = window.hide(); }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Pluks");
}
