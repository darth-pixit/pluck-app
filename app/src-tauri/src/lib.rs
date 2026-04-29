mod history;
mod selection;
mod settings;

use history::{Database, HistoryItem};
use selection::{
    activate_pid, ax_is_trusted, frontmost_pid, input_monitoring_granted, read_clipboard,
    simulate_copy, simulate_paste, start_listener, write_clipboard, Clipboard, SelectionSignal,
};

use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};


use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, State, WebviewWindow,
};

const WIN_HISTORY: &str = "history";
const EVT_NEW_SELECTION: &str = "new-selection";
const EVT_KEYBOARD_OPEN: &str = "keyboard-open";

const TRAY_TOGGLE: &str = "toggle";
const TRAY_HISTORY: &str = "history";
const TRAY_QUIT: &str = "quit";
const TRAY_LABEL_DISABLE: &str = "Disable Auto-Copy";
const TRAY_LABEL_ENABLE: &str = "Enable Auto-Copy";

// ── Shared app state ──────────────────────────────────────────────────────────

pub struct AppState {
    pub db: Arc<Mutex<Database>>,
    pub watcher_enabled: Arc<Mutex<bool>>,
    /// PID of the app that was foreground when the panel was last opened.
    /// We reactivate this app right before pasting so Cmd+V lands in the
    /// user's intended target rather than wherever focus happens to be.
    pub target_pid: Arc<Mutex<Option<i32>>>,
}

impl AppState {
    fn db(&self) -> MutexGuard<'_, Database> {
        self.db.lock().unwrap_or_else(|p| p.into_inner())
    }
    fn watcher_enabled(&self) -> bool {
        *self.watcher_enabled.lock().unwrap_or_else(|p| p.into_inner())
    }
    fn set_watcher(&self, enabled: bool) {
        *self.watcher_enabled.lock().unwrap_or_else(|p| p.into_inner()) = enabled;
    }
    fn set_target_pid(&self, pid: Option<i32>) {
        *self.target_pid.lock().unwrap_or_else(|p| p.into_inner()) = pid;
    }
    fn take_target_pid(&self) -> Option<i32> {
        self.target_pid.lock().unwrap_or_else(|p| p.into_inner()).take()
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn get_history(state: State<Arc<AppState>>) -> Vec<HistoryItem> {
    state.db().get_all().unwrap_or_default()
}

#[tauri::command]
fn copy_item(id: i64, state: State<Arc<AppState>>) -> bool {
    let text = state.db().get_content_by_id(id).ok().flatten();
    text.map(|t| write_clipboard(&t)).unwrap_or(false)
}

/// Push arbitrary text onto the clipboard. Used by smart-paste detectors that
/// need to paste a transformed variant of a history item (pretty JSON, markdown
/// link, rgb() form of a hex color, etc.) rather than the raw stored content.
#[tauri::command]
fn copy_text(text: String) -> bool {
    write_clipboard(&text)
}

#[tauri::command]
fn delete_item(id: i64, state: State<Arc<AppState>>) -> bool {
    state.db().delete(id).is_ok()
}

#[tauri::command]
fn clear_history(state: State<Arc<AppState>>) -> bool {
    state.db().clear_all().is_ok()
}

#[tauri::command]
fn check_accessibility() -> bool {
    ax_is_trusted()
}

#[tauri::command]
fn check_input_monitoring() -> bool {
    input_monitoring_granted()
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

/// Called by the frontend after hiding the panel to paste into the previous app.
/// Reactivates the captured target app first so Cmd+V lands in it specifically,
/// regardless of where focus happens to be at this exact moment.
#[tauri::command]
fn invoke_paste(state: State<Arc<AppState>>) {
    if let Some(pid) = state.take_target_pid() {
        activate_pid(pid);
        // Give AppKit a moment to switch the frontmost app and route the
        // synthesized Cmd+V to it.
        std::thread::sleep(Duration::from_millis(80));
    }
    simulate_paste();
}

// ── Window helpers ─────────────────────────────────────────────────────────────

// Raw Objective-C runtime FFI for one-time class registration.
#[cfg(target_os = "macos")]
extern "C" {
    fn objc_getClass(name: *const u8) -> *mut objc2::runtime::AnyObject;
    fn object_setClass(
        obj: *mut objc2::runtime::AnyObject,
        cls: *mut objc2::runtime::AnyObject,
    ) -> *mut objc2::runtime::AnyObject;
    fn objc_allocateClassPair(
        superclass: *mut objc2::runtime::AnyObject,
        name: *const u8,
        extra: usize,
    ) -> *mut objc2::runtime::AnyObject;
    fn objc_registerClassPair(cls: *mut objc2::runtime::AnyObject);
    fn class_addMethod(
        cls: *mut objc2::runtime::AnyObject,
        name: *mut objc2::runtime::AnyObject,
        imp: usize,
        types: *const u8,
    ) -> bool;
    fn sel_registerName(name: *const u8) -> *mut objc2::runtime::AnyObject;
}

#[cfg(target_os = "macos")]
extern "C" fn pluks_returns_yes(
    _: *mut objc2::runtime::AnyObject,
    _: *mut objc2::runtime::AnyObject,
) -> bool {
    true
}

/// Lazily registers a `PluksPanel : NSPanel` subclass that returns YES from
/// canBecomeKeyWindow / canBecomeMainWindow. A borderless NSPanel with
/// NonactivatingPanel style returns NO by default, which is why our webview
/// was never receiving Escape/keyup/blur events. Returning YES lets the
/// panel become key so keystrokes reach the webview, while the
/// NonactivatingPanel mask still prevents the host app from activating —
/// so we get input AND keep overlay-over-fullscreen behavior.
#[cfg(target_os = "macos")]
unsafe fn pluks_panel_class() -> *mut objc2::runtime::AnyObject {
    use std::sync::OnceLock;
    static CLS: OnceLock<usize> = OnceLock::new();
    let raw = *CLS.get_or_init(|| {
        let nspanel = objc_getClass(b"NSPanel\0".as_ptr());
        let cls = objc_allocateClassPair(nspanel, b"PluksPanel\0".as_ptr(), 0);
        // Type encoding: "c@:" — returns BOOL (signed char), takes (id self, SEL _cmd).
        let types = b"c@:\0";
        let sel_key = sel_registerName(b"canBecomeKeyWindow\0".as_ptr());
        let sel_main = sel_registerName(b"canBecomeMainWindow\0".as_ptr());
        class_addMethod(cls, sel_key, pluks_returns_yes as usize, types.as_ptr());
        class_addMethod(cls, sel_main, pluks_returns_yes as usize, types.as_ptr());
        objc_registerClassPair(cls);
        cls as usize
    });
    raw as *mut objc2::runtime::AnyObject
}

/// One-time native window tweaks so the panel overlays correctly — including
/// over other apps' full-screen Spaces, while still receiving keyboard input.
#[cfg(target_os = "macos")]
fn configure_overlay_window<R: Runtime>(window: &WebviewWindow<R>) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let Ok(ns) = window.ns_window() else { return };
    if ns.is_null() { return; }
    let ns = ns as *mut AnyObject;

    // CanJoinAllSpaces | FullScreenAuxiliary | Transient | Stationary | IgnoresCycle
    const COLLECTION: u64 = (1 << 0) | (1 << 8) | (1 << 3) | (1 << 4) | (1 << 6);
    const SCREENSAVER_LEVEL: isize = 1000;
    const NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL: u64 = 1 << 7;

    unsafe {
        // Swap class to our PluksPanel subclass that can become key.
        let cls = pluks_panel_class();
        if !cls.is_null() {
            object_setClass(ns, cls);
        }

        let current_mask: u64 = msg_send![ns, styleMask];
        let new_mask = current_mask | NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL;
        let _: () = msg_send![ns, setStyleMask: new_mask];

        let _: () = msg_send![ns, setLevel: SCREENSAVER_LEVEL];
        let _: () = msg_send![ns, setCollectionBehavior: COLLECTION];
        let _: () = msg_send![ns, setHidesOnDeactivate: false];
        let _: () = msg_send![ns, setMovableByWindowBackground: true];
    }
}

#[cfg(target_os = "macos")]
fn order_front_regardless<R: Runtime>(window: &WebviewWindow<R>) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let Ok(ns) = window.ns_window() else { return };
    if ns.is_null() { return; }
    let ns = ns as *mut AnyObject;

    // For a NonactivatingPanel we deliberately do NOT call
    // activateIgnoringOtherApps — that would yank the user out of the
    // foreground app's full-screen Space. orderFrontRegardless +
    // makeKeyAndOrderFront brings the panel up in place.
    unsafe {
        let _: () = msg_send![ns, orderFrontRegardless];
        let _: () = msg_send![ns, makeKeyAndOrderFront: std::ptr::null_mut::<AnyObject>()];
    }
}

#[cfg(not(target_os = "macos"))]
fn configure_overlay_window<R: Runtime>(_window: &WebviewWindow<R>) {}
#[cfg(not(target_os = "macos"))]
fn order_front_regardless<R: Runtime>(_window: &WebviewWindow<R>) {}

fn show_history_window<R: Runtime>(window: &WebviewWindow<R>, keyboard: bool) {
    let _ = window.center();
    let _ = window.show();
    order_front_regardless(window);
    let _ = window.set_focus();
    if keyboard {
        let _ = window.emit(EVT_KEYBOARD_OPEN, ());
    }
}

fn toggle_history_window<R: Runtime>(app: &AppHandle<R>, keyboard: bool) {
    let Some(win) = app.get_webview_window(WIN_HISTORY) else { return };
    let visible = win.is_visible().unwrap_or(false);
    if !visible {
        // Capture which app is foreground RIGHT NOW so we can route paste
        // back to it later. Skip if it's our own process (e.g. Pluks tray
        // click while panel is closed but our app happens to be frontmost).
        if let Some(state) = app.try_state::<Arc<AppState>>() {
            let our_pid = std::process::id() as i32;
            let target = frontmost_pid().filter(|&p| p != our_pid);
            state.set_target_pid(target);
        }
        show_history_window(&win, keyboard);
        return;
    }
    if keyboard {
        let _ = win.set_focus();
        let _ = win.emit(EVT_KEYBOARD_OPEN, ());
        return;
    }
    let _ = win.hide();
}

// ── Background processing loop ─────────────────────────────────────────────────

fn panel_visible(app_handle: &AppHandle) -> bool {
    app_handle
        .get_webview_window(WIN_HISTORY)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

fn start_copy_processor(
    rx: mpsc::Receiver<SelectionSignal>,
    state: Arc<AppState>,
    app_handle: AppHandle,
) {
    thread::spawn(move || {
        // Reuse a single Clipboard handle across the polling loop instead of constructing
        // ~25 fresh instances per selection.
        let mut clip: Option<Clipboard> = Clipboard::new().ok();

        for SelectionSignal in rx {
            if !state.watcher_enabled() || panel_visible(&app_handle) {
                continue;
            }

            let before = read_clipboard(&mut clip);
            thread::sleep(Duration::from_millis(80));

            // Re-check just before firing Cmd+C: the panel may have appeared or the
            // user may have toggled auto-copy off during the sleep.
            if !state.watcher_enabled() || panel_visible(&app_handle) {
                continue;
            }

            simulate_copy();

            // Adaptive wait: poll until clipboard changes or 600 ms elapses.
            let after = {
                let deadline = Instant::now() + Duration::from_millis(600);
                let mut latest = read_clipboard(&mut clip);
                while latest.as_deref() == before.as_deref() && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(25));
                    latest = read_clipboard(&mut clip);
                }
                latest
            };

            if let Some(text) = after {
                if before.as_deref() != Some(&text) {
                    let item = state.db().insert(&text);
                    if let Ok(item) = item {
                        let _ = app_handle.emit(EVT_NEW_SELECTION, &item);
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
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use tauri::ActivationPolicy;
                app.set_activation_policy(ActivationPolicy::Accessory);
            }

            // Only enable autolaunch on first ever launch. Re-enabling on every startup
            // would silently overwrite a user's deliberate "off" in System Settings.
            {
                use tauri_plugin_autostart::ManagerExt;
                let al = app.autolaunch();
                if !al.is_enabled().unwrap_or(false) {
                    let _ = al.enable();
                }
            }

            // Configure the history window as a floating overlay panel.
            if let Some(win) = app.get_webview_window(WIN_HISTORY) {
                configure_overlay_window(&win);
            }

            let db_path = app.path().app_data_dir().expect("no app data dir").join("pluck.db");
            let db = Database::new(db_path).expect("failed to open database");
            let state = Arc::new(AppState {
                db: Arc::new(Mutex::new(db)),
                watcher_enabled: Arc::new(Mutex::new(true)),
                target_pid: Arc::new(Mutex::new(None)),
            });
            app.manage(state.clone());

            // ── Tray ─────────────────────────────────────────────────────
            let toggle_item =
                MenuItem::with_id(app, TRAY_TOGGLE, TRAY_LABEL_DISABLE, true, None::<&str>)?;
            let history_item = MenuItem::with_id(
                app,
                TRAY_HISTORY,
                "Show / Hide History (⌘⇧V)",
                true,
                None::<&str>,
            )?;
            let quit_item = MenuItem::with_id(app, TRAY_QUIT, "Quit Pluks", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle_item, &history_item, &quit_item])?;

            let _ = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("Pluks — select to copy")
                .on_menu_event({
                    let app_handle = app.handle().clone();
                    let state_ref = state.clone();
                    let toggle_item = toggle_item.clone();
                    move |_tray, event| match event.id().as_ref() {
                        TRAY_TOGGLE => {
                            let next = !state_ref.watcher_enabled();
                            state_ref.set_watcher(next);
                            let _ = toggle_item.set_text(if next {
                                TRAY_LABEL_DISABLE
                            } else {
                                TRAY_LABEL_ENABLE
                            });
                        }
                        TRAY_HISTORY => toggle_history_window(&app_handle, false),
                        TRAY_QUIT => app_handle.exit(0),
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_history_window(tray.app_handle(), false);
                    }
                })
                .build(app)?;

            // ── Global shortcuts ─────────────────────────────────────────
            {
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
                let toggle: Shortcut = "CmdOrCtrl+Shift+V".parse().unwrap();
                let app_handle = app.handle().clone();
                if let Err(e) =
                    app.global_shortcut()
                        .on_shortcut(toggle, move |_app, _shortcut, event| {
                            if event.state == ShortcutState::Pressed {
                                toggle_history_window(&app_handle, true);
                            }
                        })
                {
                    eprintln!("[pluks] failed to register Cmd+Shift+V: {:?}", e);
                }

                // Cmd+Shift+Up / Down: navigate while the panel is visible.
                // Registered globally because macOS swallows arrow-key keydowns
                // inside a webview while Cmd is held — they never reach JS.
                for (combo, evt_name) in [
                    ("CmdOrCtrl+Shift+Up", "navigate-up"),
                    ("CmdOrCtrl+Shift+Down", "navigate-down"),
                ] {
                    let shortcut: Shortcut = combo.parse().unwrap();
                    let app_handle = app.handle().clone();
                    let evt_name = evt_name.to_string();
                    if let Err(e) = app.global_shortcut().on_shortcut(
                        shortcut,
                        move |_app, _shortcut, event| {
                            if event.state == ShortcutState::Pressed
                                && panel_visible(&app_handle)
                            {
                                let _ = app_handle.emit(&evt_name, ());
                            }
                        },
                    ) {
                        eprintln!("[pluks] failed to register {}: {:?}", combo, e);
                    }
                }
            }

            // Bounded channel: under bursts (drag-select 30 times in 1 s), the rdev
            // listener will drop signals while the processor is mid-cycle rather than
            // queue 18 s of stale work.
            let (tx, rx) = mpsc::sync_channel::<SelectionSignal>(1);
            start_listener(tx);
            start_copy_processor(rx, state, app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_history,
            copy_item,
            copy_text,
            delete_item,
            clear_history,
            check_accessibility,
            check_input_monitoring,
            open_accessibility_settings,
            open_input_monitoring_settings,
            invoke_paste,
            settings::get_settings,
            settings::set_settings,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == WIN_HISTORY {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Pluks");
}
