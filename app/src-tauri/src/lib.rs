mod history;
mod selection;
mod settings;

use history::{Database, HistoryItem};
use selection::{
    activate_pid, ax_is_trusted, cursor_pos, focus_is_editable, frontmost_pid,
    input_monitoring_granted, read_clipboard, simulate_copy, simulate_paste, start_listener,
    write_clipboard, Clipboard, ManualCopySignal, SelectionSignal,
};

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};


use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, State, WebviewWindow,
};

const WIN_HISTORY: &str = "history";
const WIN_NUDGE: &str = "nudge";
const EVT_NEW_SELECTION: &str = "new-selection";
const EVT_KEYBOARD_OPEN: &str = "keyboard-open";
const EVT_NUDGE_SHOW: &str = "nudge-show";

// How far down + right of the cursor the nudge floats. Big enough that
// the user's hand doesn't obscure it; small enough that it reads as
// "this is about what you just did."
const NUDGE_OFFSET_X: f64 = 18.0;
const NUDGE_OFFSET_Y: f64 = 18.0;
const NUDGE_WIDTH: f64 = 220.0;
const NUDGE_HEIGHT: f64 = 44.0;
// Visible lifetime of one nudge. CSS keyframes in NudgeView assume the
// pill is in the DOM for this long; bumping this requires bumping the
// fade-out keyframe delay too. Single source of truth.
const NUDGE_LIFETIME_MS: u64 = 1100;
// Emitted when the copy processor declines to capture because the user's
// focus is in an editable text field (drag-to-replace gesture). The
// frontend forwards this to PostHog as `selection_capture_failed` so we can
// see the new path firing in the wild without needing local debug builds.
const EVT_CAPTURE_SUPPRESSED: &str = "capture-suppressed";
// Emitted when the user pressed Cmd+C / Ctrl+C themselves within 5s of a
// successful Pluks capture — signal of "user doesn't trust the magic yet".
// Drives both the analytics funnel and (later) adaptive nudging.
const EVT_MANUAL_COPY: &str = "manual-copy";

// How recent a Pluks capture must be for a user-driven Cmd+C to count as
// a "redundant manual copy" worth tracking. Bumping this widens the
// definition; shrinking it reduces noise.
const MANUAL_COPY_WINDOW_MS: u128 = 5_000;
// Synthetic Cmd+C from our own simulate_copy() typically arrives within
// ~150 ms of `last_synthetic_copy_at`. 250 ms is conservative.
const SYNTHETIC_COPY_GUARD_MS: u128 = 250;

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
    /// When the last successful Pluks capture landed. Read by the manual-copy
    /// processor to decide whether a user Cmd+C is a "redundant" press.
    pub last_capture_at: Arc<Mutex<Option<Instant>>>,
    /// When the copy processor last fired its own simulate_copy(). The
    /// CGEventTap also sees that synthetic Cmd+C; without this guard it
    /// would be miscounted as a manual copy.
    pub last_synthetic_copy_at: Arc<Mutex<Option<Instant>>>,
    /// Monotonic ID for the most-recently-shown nudge. Each show_nudge
    /// increments it; the hide task captures the value at show-time and
    /// only hides if it's still current — otherwise a fast-second nudge
    /// would have its window yanked out from under it by the prior
    /// nudge's stale hide task.
    pub nudge_gen: Arc<AtomicU64>,
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
    fn mark_capture(&self) {
        *self.last_capture_at.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
    }
    fn mark_synthetic_copy(&self) {
        *self.last_synthetic_copy_at.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(Instant::now());
    }
    fn last_capture_age_ms(&self) -> Option<u128> {
        self.last_capture_at
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .map(|t| t.elapsed().as_millis())
    }
    fn last_synthetic_copy_age_ms(&self) -> Option<u128> {
        self.last_synthetic_copy_at
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .map(|t| t.elapsed().as_millis())
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

/// Position the dedicated nudge window near the cursor and surface a
/// `nudge-show` event to its webview so the React component renders
/// the appropriate copy. Re-firing while a previous nudge is still
/// fading retargets position + payload and bumps the generation
/// counter so the prior hide task no-ops instead of yanking the
/// window out from under the new nudge.
#[tauri::command]
fn show_nudge(app: AppHandle, state: State<Arc<AppState>>, kind: String, text: String) {
    let Some(win) = app.get_webview_window(WIN_NUDGE) else {
        return;
    };
    let my_gen = state.nudge_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let (cx, cy) = cursor_pos();
    let _ = win.set_position(tauri::LogicalPosition::new(
        cx + NUDGE_OFFSET_X,
        cy + NUDGE_OFFSET_Y,
    ));
    let _ = win.set_size(tauri::LogicalSize::new(NUDGE_WIDTH, NUDGE_HEIGHT));
    let _ = win.show();
    let _ = win.emit(
        EVT_NUDGE_SHOW,
        serde_json::json!({ "kind": kind, "text": text }),
    );

    let app_for_hide = app.clone();
    let gen_arc = state.nudge_gen.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(NUDGE_LIFETIME_MS));
        if gen_arc.load(Ordering::SeqCst) != my_gen {
            return;
        }
        if let Some(w) = app_for_hide.get_webview_window(WIN_NUDGE) {
            let _ = w.hide();
        }
    });
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

// On Windows & Linux the overlay behavior is handled declaratively by
// tauri.conf.json (alwaysOnTop, skipTaskbar, visibleOnAllWorkspaces,
// decorations:false, transparent:true). We re-assert always-on-top here as
// a belt-and-suspenders against window managers that strip the hint when
// the window is initially hidden.
//
// Caveats outside our control:
//   - Linux/X11 transparency requires a compositing WM; without one the
//     panel renders with an opaque background.
//   - Wayland compositors typically refuse always-on-top from arbitrary
//     clients; the panel will still appear, just not stay above fullscreen.
//   - Win32 doesn't have macOS's per-Space "join all spaces" concept;
//     alwaysOnTop is the closest equivalent.
#[cfg(not(target_os = "macos"))]
fn configure_overlay_window<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.set_always_on_top(true);
    let _ = window.set_skip_taskbar(true);
}
#[cfg(not(target_os = "macos"))]
fn order_front_regardless<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.set_focus();
}

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

            // Snapshot the clipboard BEFORE touching anything. We need this for
            // two reasons: (1) deduping the captured text against the user's
            // current clipboard, and (2) restoring it untouched when the
            // capture lands inside an editable field (drag-to-replace gesture).
            let before = read_clipboard(&mut clip);

            // Detect editable focus before the settle-sleep so a fast typer
            // who starts replacing within 80ms still gets their selection
            // recorded. We re-check after the sleep too — if AX flips state
            // between the two reads we treat the gesture as editable, which
            // is the safer default for clipboard-restore.
            let editable_pre = focus_is_editable();
            thread::sleep(Duration::from_millis(80));

            // Re-check just before firing Cmd+C: the panel may have appeared
            // or the user may have toggled auto-copy off during the sleep.
            if !state.watcher_enabled() || panel_visible(&app_handle) {
                continue;
            }
            let editable = editable_pre || focus_is_editable();

            // Stamp BEFORE firing so the manual-copy listener can ignore the
            // synthetic Cmd+C this is about to generate.
            state.mark_synthetic_copy();
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
                        state.mark_capture();
                        let _ = app_handle.emit(EVT_NEW_SELECTION, &item);
                    }
                    // Editable focus = drag-to-replace. The selection is now
                    // safely at the top of history (recoverable / re-pastable
                    // at the next position), so put the user's prior clipboard
                    // back. This preserves their existing Cmd+V target and
                    // keeps the overwritten text out of the system clipboard
                    // — they'll type-replace cleanly without our Cmd+C
                    // side-effect leaking into a later paste.
                    if editable {
                        let _ = match before.as_deref() {
                            Some(prev) => write_clipboard(prev),
                            None => write_clipboard(""),
                        };
                        let _ = app_handle.emit(EVT_CAPTURE_SUPPRESSED, "editable_focus_restored");
                    }
                }
            } else if editable {
                // Cmd+C produced nothing (selection vanished mid-replace, or AX
                // disagrees with reality). Nothing to restore, but keep the
                // telemetry so we can see the editable path firing in the wild.
                let _ = app_handle.emit(EVT_CAPTURE_SUPPRESSED, "editable_focus_empty");
            }
        }
    });
}

/// Tracks user-driven Cmd+C presses that follow a Pluks capture — the signal
/// of "user doesn't yet trust the auto-copy and double-confirms manually."
/// Emits `manual-copy` to the frontend with the time-since-last-capture
/// bucket; the frontend forwards as a PostHog event.
///
/// Filters: drops anything within `SYNTHETIC_COPY_GUARD_MS` of our own
/// simulate_copy() (those are our synthetic Cmd+Cs), drops anything with no
/// recent capture (that's just the user copying normally, not redundantly),
/// drops anything while the panel is visible (Cmd+C inside Pluks is a
/// different intent).
fn start_manual_copy_processor(
    rx: mpsc::Receiver<ManualCopySignal>,
    state: Arc<AppState>,
    app_handle: AppHandle,
) {
    thread::spawn(move || {
        for ManualCopySignal in rx {
            if panel_visible(&app_handle) {
                continue;
            }
            if let Some(age) = state.last_synthetic_copy_age_ms() {
                if age < SYNTHETIC_COPY_GUARD_MS {
                    continue;
                }
            }
            let Some(since_capture_ms) = state.last_capture_age_ms() else {
                continue;
            };
            if since_capture_ms > MANUAL_COPY_WINDOW_MS {
                continue;
            }
            // Bucket on the Rust side so the frontend doesn't have to know
            // the buckets — schema allow-list takes only `since_last_capture_ms_bucket`.
            let bucket = if since_capture_ms < 1_000 {
                "0-1000"
            } else if since_capture_ms < 3_000 {
                "1000-3000"
            } else {
                "3000-5000"
            };
            let _ = app_handle.emit(EVT_MANUAL_COPY, bucket);
        }
    });
}

// ── App entry point ────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The MacosLauncher arg only takes effect on macOS — on Windows the
        // plugin writes a registry Run entry, on Linux it drops a .desktop
        // autostart file. Same call works cross-platform; only the macOS
        // codepath consults this enum.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Background auto-updater. Downloads + signature verification happen in
        // Rust; the JS side decides when to apply the update so we never yank
        // the app out from under the user mid-session.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Needed so the JS side can relaunch after a deferred install.
        .plugin(tauri_plugin_process::init())
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

            // Configure the nudge window: same overlay treatment so it
            // floats over every Space + full-screen, plus click-through
            // so the user can never accidentally interact with it. We
            // explicitly do NOT call makeKey on it — nudges must never
            // steal focus from whatever the user is typing in.
            if let Some(win) = app.get_webview_window(WIN_NUDGE) {
                configure_overlay_window(&win);
                let _ = win.set_ignore_cursor_events(true);
            }

            let db_path = app.path().app_data_dir().expect("no app data dir").join("pluck.db");
            let db = Database::new(db_path).expect("failed to open database");
            let state = Arc::new(AppState {
                db: Arc::new(Mutex::new(db)),
                watcher_enabled: Arc::new(Mutex::new(true)),
                target_pid: Arc::new(Mutex::new(None)),
                last_capture_at: Arc::new(Mutex::new(None)),
                last_synthetic_copy_at: Arc::new(Mutex::new(None)),
                nudge_gen: Arc::new(AtomicU64::new(0)),
            });
            app.manage(state.clone());

            // ── Tray ─────────────────────────────────────────────────────
            let toggle_item =
                MenuItem::with_id(app, TRAY_TOGGLE, TRAY_LABEL_DISABLE, true, None::<&str>)?;
            let history_label = if cfg!(target_os = "macos") {
                "Show / Hide History (⌘⇧V)"
            } else {
                "Show / Hide History (Ctrl+Shift+V)"
            };
            let history_item = MenuItem::with_id(
                app,
                TRAY_HISTORY,
                history_label,
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
                        TRAY_QUIT => {
                            // Give the frontend a chance to install a staged
                            // update before we tear down. The listener has up
                            // to 800ms to call install_update + relaunch; if
                            // none is staged, it no-ops and we exit normally.
                            let _ = app_handle.emit("app-quit-requested", ());
                            let h = app_handle.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(Duration::from_millis(800));
                                h.exit(0);
                            });
                        }
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
            // Manual-copy channel is bounded slightly higher: a user mashing
            // Cmd+C four times shouldn't lose the analytics signal, but we
            // still want backpressure if something stalls.
            let (tx_manual, rx_manual) = mpsc::sync_channel::<ManualCopySignal>(4);
            start_listener(tx, tx_manual);
            start_copy_processor(rx, state.clone(), app.handle().clone());
            start_manual_copy_processor(rx_manual, state, app.handle().clone());

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
            show_nudge,
            settings::get_settings,
            settings::set_settings,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label();
                if label == WIN_HISTORY || label == WIN_NUDGE {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Pluks");
}
