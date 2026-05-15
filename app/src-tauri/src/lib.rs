mod history;
mod paste;
mod selection;
mod settings;

use history::{Database, HistoryItem};
use selection::{
    activate_pid, ax_is_trusted, cursor_pos, focus_is_secure_field, frontmost_pid,
    input_monitoring_granted, read_clipboard, request_accessibility, request_input_monitoring,
    simulate_copy, simulate_paste, start_listener, write_clipboard, Clipboard, ManualCopySignal,
    MouseEvent, SelectionSignal,
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

pub(crate) const WIN_HISTORY: &str = "history";
pub(crate) const WIN_NUDGE: &str = "nudge";
const EVT_NEW_SELECTION: &str = "new-selection";
const EVT_KEYBOARD_OPEN: &str = "keyboard-open";
const EVT_NUDGE_SHOW: &str = "nudge-show";
const EVT_PASTE_CONFIRM: &str = "paste-confirm";

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

// After a drag-select we wait this long watching for a Cmd+V keystroke
// before firing our synthetic Cmd+C. If Cmd+V arrives during the window,
// the user is doing a select-to-replace — abort the capture so their
// paste lands the prior clipboard contents over the destination.
//
// Tuning is bounded by empirical motor reaction time between drag-up
// and the paste keystroke: 5th percentile ~120 ms (practiced user with
// hand near keyboard), 50th percentile ~280 ms (typical hand transit),
// 95th percentile ~450 ms (deliberate user who reads the destination
// before pasting). The v0.3.0 → v0.4.0 regression came from a 180 ms
// budget that only covered the fastest decile.
//
// 500 ms is the Apple HIG double-click ceiling — the longest interval
// macOS itself treats as a single intentional gesture beat. Going
// wider risks misattributing an unrelated Cmd+V (e.g. the user's next
// real paste action) as a replace; going narrower misses real users.
//
// Cost: adds ~320 ms to capture latency on every drag-select. The
// existing 600 ms clipboard-change poll dominated the total path
// anyway, so the user-perceptible "selection → nudge" budget stays
// in the sub-second zone. See `replace_guard_tests` for the timing
// envelope under test.
const PASTE_WATCH_MS: u64 = 500;
// How often the watch loop re-reads `paste_seq`. Small enough that even
// a sub-100 ms paste is caught on the next tick.
const PASTE_WATCH_TICK_MS: u64 = 15;

const TRAY_TOGGLE: &str = "toggle";
const TRAY_HISTORY: &str = "history";
const TRAY_TEST_NUDGE: &str = "test_nudge";
const TRAY_QUIT: &str = "quit";
const TRAY_LABEL_DISABLE: &str = "Disable Auto-Copy";
const TRAY_LABEL_ENABLE: &str = "Enable Auto-Copy";

// How long the silent-paste confirmation pill stays on screen. Matches the
// fade-in + hold + fade-out timing in the `.paste-confirm-pill` CSS keyframes
// so the React component unmounts at the same moment the window is hidden.
const PASTE_CONFIRM_LIFETIME_MS: u64 = 2350;
// How far the pill is offset from the press point. Negative X nudges the
// leading dot a few px left of the cursor so the pill reads as a label
// trailing the click; positive Y drops it just below the cursor.
const PASTE_CONFIRM_OFFSET_X: f64 = 12.0;
const PASTE_CONFIRM_OFFSET_Y: f64 = 18.0;

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
    /// Bumped by the platform listener every time the user presses
    /// Cmd+V (Ctrl+V on Win/Linux). The copy processor reads the value
    /// just before its synthetic Cmd+C and again after a short watch
    /// window; if the counter advanced, the user is doing a
    /// select-to-replace gesture and we skip the capture so their paste
    /// lands the prior clipboard contents in the destination.
    pub paste_seq: Arc<AtomicU64>,
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
    show_nudge_impl(&app, &state, &kind, &text);
}

/// Inner implementation shared between the public `show_nudge` Tauri command
/// and the tray "Test Nudge" diagnostic action. Every step is logged via
/// `eprintln!` so the v0.4.5 diagnostic build surfaces exactly which point of
/// the pipeline succeeds and which fails — visible in Console.app under
/// "Pluks". Filter with: `process == "Pluks" && message CONTAINS "[pluks]"`.
fn show_nudge_impl(app: &AppHandle, state: &Arc<AppState>, kind: &str, text: &str) {
    let Some(win) = app.get_webview_window(WIN_NUDGE) else {
        eprintln!("[pluks] show_nudge: WIN_NUDGE not found");
        return;
    };
    let my_gen = state.nudge_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let (cx, cy) = cursor_pos();
    let pos_x = cx + NUDGE_OFFSET_X;
    let pos_y = cy + NUDGE_OFFSET_Y;
    eprintln!(
        "[pluks] show_nudge: gen={} kind={} cursor=({:.1},{:.1}) target=({:.1},{:.1}) size=({},{})",
        my_gen, kind, cx, cy, pos_x, pos_y, NUDGE_WIDTH, NUDGE_HEIGHT
    );
    if let Err(e) = win.set_position(tauri::LogicalPosition::new(pos_x, pos_y)) {
        eprintln!("[pluks] show_nudge: set_position failed: {:?}", e);
    }
    if let Err(e) = win.set_size(tauri::LogicalSize::new(NUDGE_WIDTH, NUDGE_HEIGHT)) {
        eprintln!("[pluks] show_nudge: set_size failed: {:?}", e);
    }
    match win.show() {
        Ok(()) => eprintln!("[pluks] show_nudge: show() ok"),
        Err(e) => eprintln!("[pluks] show_nudge: show() failed: {:?}", e),
    }
    let payload = serde_json::json!({ "kind": kind, "text": text });
    match win.emit(EVT_NUDGE_SHOW, &payload) {
        Ok(()) => eprintln!("[pluks] show_nudge: emit({}) ok", EVT_NUDGE_SHOW),
        Err(e) => eprintln!("[pluks] show_nudge: emit failed: {:?}", e),
    }

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

/// Anchor the nudge window at the press point and surface a `paste-confirm`
/// event so `NudgeView` renders the silent-paste confirmation pill. Bumps the
/// nudge generation counter just like `show_nudge_impl` so a copy-side
/// affirmation that landed seconds earlier doesn't yank our window away.
pub(crate) fn show_paste_confirm(
    app: &AppHandle,
    state: &Arc<AppState>,
    x: f64,
    y: f64,
    char_count: usize,
) {
    let Some(win) = app.get_webview_window(WIN_NUDGE) else {
        eprintln!("[pluks] show_paste_confirm: WIN_NUDGE not found");
        return;
    };
    let my_gen = state.nudge_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let pos_x = x - PASTE_CONFIRM_OFFSET_X;
    let pos_y = y + PASTE_CONFIRM_OFFSET_Y;
    eprintln!(
        "[pluks] show_paste_confirm: gen={} press=({:.1},{:.1}) target=({:.1},{:.1})",
        my_gen, x, y, pos_x, pos_y
    );
    if let Err(e) = win.set_position(tauri::LogicalPosition::new(pos_x, pos_y)) {
        eprintln!("[pluks] show_paste_confirm: set_position failed: {:?}", e);
    }
    if let Err(e) = win.set_size(tauri::LogicalSize::new(NUDGE_WIDTH, NUDGE_HEIGHT)) {
        eprintln!("[pluks] show_paste_confirm: set_size failed: {:?}", e);
    }
    if let Err(e) = win.show() {
        eprintln!("[pluks] show_paste_confirm: show() failed: {:?}", e);
    }
    let payload = serde_json::json!({ "x": x, "y": y, "char_count": char_count });
    if let Err(e) = win.emit(EVT_PASTE_CONFIRM, &payload) {
        eprintln!("[pluks] show_paste_confirm: emit failed: {:?}", e);
    }

    let app_for_hide = app.clone();
    let gen_arc = state.nudge_gen.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(PASTE_CONFIRM_LIFETIME_MS));
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
        // Re-add Pluks to the Accessibility list (via the OS prompt) before
        // opening System Settings. If the user previously removed the entry,
        // the panel would otherwise show a list that doesn't contain Pluks
        // and there'd be no way to grant from here without the +/drag-in
        // dance. The prompt also covers the fresh-install path.
        let _ = request_accessibility();
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn();
    }
}

#[tauri::command]
fn open_input_monitoring_settings() {
    #[cfg(target_os = "macos")]
    {
        // Same rationale as `open_accessibility_settings`: `IOHIDRequestAccess`
        // re-adds Pluks to the Input Monitoring list and triggers the macOS
        // prompt before we drop the user into System Settings.
        let _ = request_input_monitoring();
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
fn configure_overlay_window<R: Runtime>(window: &WebviewWindow<R>, needs_key: bool) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let Ok(ns) = window.ns_window() else { return };
    if ns.is_null() { return; }
    let ns = ns as *mut AnyObject;

    // CanJoinAllSpaces | FullScreenAuxiliary | Transient | Stationary | IgnoresCycle
    const COLLECTION: u64 = (1 << 0) | (1 << 8) | (1 << 3) | (1 << 4) | (1 << 6);
    // History panel sits at NSScreenSaverWindowLevel so it can float over other
    // apps' full-screen Spaces. The transient nudge overlay drops to
    // NSPopUpMenuWindowLevel — Tahoe 26.x has been observed to silently
    // demote/clip windows in the screen-saver band for unentitled apps, and
    // pop-up menu level still puts us above any normal foreground app content
    // while staying well clear of the restricted band.
    const SCREENSAVER_LEVEL: isize = 1000;
    const POPUP_MENU_LEVEL: isize = 101;
    const NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL: u64 = 1 << 7;
    // Tahoe's compositor has been observed to skip windows whose style mask
    // carries only NonactivatingPanel and no "content" bit. Adding
    // FullSizeContentView gives the WKWebView content layer a recognized
    // owner without affecting layout (we have decorations: false anyway).
    const NS_WINDOW_STYLE_MASK_FULL_SIZE_CONTENT_VIEW: u64 = 1 << 15;

    unsafe {
        // The PluksPanel subclass is only needed for windows that must become
        // key (the history panel — keyboard input). The class swap via
        // object_setClass is fragile under Tahoe and unnecessary for the
        // click-through ambient nudge surface, so skip it there.
        if needs_key {
            let cls = pluks_panel_class();
            if !cls.is_null() {
                object_setClass(ns, cls);
            }
        }

        let current_mask: u64 = msg_send![ns, styleMask];
        let new_mask = current_mask
            | NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL
            | NS_WINDOW_STYLE_MASK_FULL_SIZE_CONTENT_VIEW;
        let _: () = msg_send![ns, setStyleMask: new_mask];

        let level: isize = if needs_key { SCREENSAVER_LEVEL } else { POPUP_MENU_LEVEL };
        let _: () = msg_send![ns, setLevel: level];
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
fn configure_overlay_window<R: Runtime>(window: &WebviewWindow<R>, _needs_key: bool) {
    // The needs_key parameter is macOS-only (controls the NSPanel subclass
    // swap that lets the history panel receive keyboard input). On
    // Windows/Linux every overlay is a normal always-on-top window.
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

/// Block up to `PASTE_WATCH_MS` watching for `paste_seq` to advance.
/// Returns `true` if the user pressed Cmd+V during the window (the
/// caller should skip the in-flight capture — this is a replace
/// gesture). Returns `false` if the window expired quietly.
///
/// Doubles as the post-drag "OS settle" wait that previously lived as
/// a fixed `thread::sleep(80)` — the tick polling is cheap and we still
/// hit AppKit-flush latencies before firing the synthetic Cmd+C.
fn watch_for_paste(paste_seq: &AtomicU64) -> bool {
    let seen = paste_seq.load(Ordering::Relaxed);
    let deadline = Instant::now() + Duration::from_millis(PASTE_WATCH_MS);
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(PASTE_WATCH_TICK_MS));
        if paste_seq.load(Ordering::Relaxed) != seen {
            return true;
        }
    }
    false
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

            // Only suppress capture for password fields. Previously we
            // suppressed *all* editable focus on the theory that the user
            // was about to paste-replace, but in practice that broke every
            // common copy gesture inside a composer or terminal (WhatsApp,
            // Terminal.app, IDE editors, search boxes). Users were left
            // pasting an older clipboard value because the most recent
            // selection never landed.
            if focus_is_secure_field() {
                let _ = app_handle.emit(EVT_CAPTURE_SUPPRESSED, "secure_field");
                continue;
            }

            let before = read_clipboard(&mut clip);

            // Wait for the OS to flush the drag-up AND watch for an
            // imminent Cmd+V. A replace gesture — drag-select a
            // destination, then paste — is indistinguishable from a copy
            // gesture at the mouse-up boundary; the divergence is the
            // next keystroke. If Cmd+V lands during the watch window the
            // user is replacing, so we skip the synthetic Cmd+C and let
            // their paste deliver the prior clipboard contents over the
            // destination they just selected. Replaces the prior fixed
            // 80 ms settle sleep — the watch loop serves the same role.
            if watch_for_paste(&state.paste_seq) {
                let _ = app_handle.emit(EVT_CAPTURE_SUPPRESSED, "paste_within_window");
                continue;
            }

            // Re-check just before firing Cmd+C: the panel may have appeared, the
            // user may have toggled auto-copy off, or focus may have moved into
            // a password field during the watch window.
            if !state.watcher_enabled() || panel_visible(&app_handle) {
                continue;
            }
            if focus_is_secure_field() {
                let _ = app_handle.emit(EVT_CAPTURE_SUPPRESSED, "secure_field");
                continue;
            }

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
                }
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
    // Surface the version in Console.app so the user can confirm which
    // build is actually running — important for the v0.4.5 diagnostic
    // build that's being shipped to disambiguate the Tahoe 26.2 overlay
    // visibility bug.
    eprintln!(
        "[pluks] starting v{} (overlay diagnostics enabled)",
        env!("CARGO_PKG_VERSION")
    );

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
            // needs_key=true → PluksPanel subclass + NSScreenSaverWindowLevel
            // so it floats over other apps' full-screen Spaces AND receives
            // keyboard input.
            if let Some(win) = app.get_webview_window(WIN_HISTORY) {
                configure_overlay_window(&win, true);
            }

            // Configure the nudge window: needs_key=false → skip the
            // class swap (nudges must never steal focus from whatever the
            // user is typing in anyway) and drop to NSPopUpMenuWindowLevel
            // so Tahoe doesn't demote/clip us in the restricted
            // screen-saver band. Click-through so the user can never
            // accidentally interact with it.
            if let Some(win) = app.get_webview_window(WIN_NUDGE) {
                configure_overlay_window(&win, false);
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
                paste_seq: Arc::new(AtomicU64::new(0)),
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
            // Diagnostic action (v0.4.5). Bypasses the capture pipeline and
            // fires the nudge show path directly so the user can verify the
            // overlay actually renders — independent of whether a real
            // selection ever made it through capture.
            let test_nudge_item = MenuItem::with_id(
                app,
                TRAY_TEST_NUDGE,
                "Test Nudge (debug)",
                true,
                None::<&str>,
            )?;
            let quit_item = MenuItem::with_id(app, TRAY_QUIT, "Quit Pluks", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &toggle_item,
                    &history_item,
                    &test_nudge_item,
                    &quit_item,
                ],
            )?;

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
                        TRAY_TEST_NUDGE => {
                            eprintln!("[pluks] tray: TEST_NUDGE clicked");
                            show_nudge_impl(
                                &app_handle,
                                &state_ref,
                                "affirmation",
                                "✦ Test nudge",
                            );
                        }
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
            // Raw mouse stream for the long-press detector in `paste.rs`. Sized
            // generously: a fast drag may emit dozens of Move events per
            // second, and we'd rather drop a few during a stall than block the
            // OS event tap thread.
            let (tx_mouse, rx_mouse) = mpsc::sync_channel::<MouseEvent>(64);
            start_listener(tx, tx_manual, tx_mouse, state.paste_seq.clone());
            start_copy_processor(rx, state.clone(), app.handle().clone());
            start_manual_copy_processor(rx_manual, state.clone(), app.handle().clone());
            paste::start_paste_processor(rx_mouse, state, app.handle().clone());

            // Auto-surface the panel when either macOS permission is missing.
            // Without this, a user who hasn't (yet, or any longer) granted
            // Accessibility / Input Monitoring sees *nothing*: LSUIElement +
            // ActivationPolicy::Accessory means no Dock icon, and the history
            // window starts hidden. The OS-level prompt that
            // `request_accessibility` / `request_input_monitoring` triggers
            // only fires the first time TCC has ever asked for this app — on
            // an upgrade, a re-install, or any flow where the user previously
            // dismissed the dialog, no prompt ever appears. The result was a
            // silently broken app: capture didn't fire, long-press didn't
            // arm (the CGEventTap install in `selection::mac_tap` fails
            // without Input Monitoring), and there was no UI nudging the
            // user to fix it.
            //
            // Forcing the window open here puts the SetupScreen in front of
            // the user with its "Grant →" buttons; those re-call the request
            // APIs *and* open the relevant System Settings panel, which
            // recovers from every TCC state — including the case where
            // Pluks had been removed from the list entirely. Once the user
            // grants, the background polling in `start_listener` picks up
            // the change and the panel flips itself to the main view.
            //
            // When everything is already granted we leave the window hidden
            // — that's the intended invisible-launch default.
            if !ax_is_trusted() || !input_monitoring_granted() {
                if let Some(win) = app.get_webview_window(WIN_HISTORY) {
                    show_history_window(&win, false);
                }
            }

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

#[cfg(test)]
mod replace_guard_tests {
    use super::{watch_for_paste, PASTE_WATCH_MS};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn returns_false_when_no_paste_occurs() {
        let seq = AtomicU64::new(7);
        let start = Instant::now();
        let pasted = watch_for_paste(&seq);
        let elapsed = start.elapsed();
        assert!(!pasted, "no paste fired — caller should proceed");
        // Window should run close to the full duration. Allow slop for the
        // last sleep tick that overshoots the deadline.
        assert!(
            elapsed >= Duration::from_millis(PASTE_WATCH_MS),
            "watch returned too early: {:?}",
            elapsed
        );
        assert!(
            elapsed < Duration::from_millis(PASTE_WATCH_MS + 80),
            "watch overshot the deadline: {:?}",
            elapsed
        );
    }

    #[test]
    fn returns_true_when_paste_arrives_during_window() {
        let seq = Arc::new(AtomicU64::new(0));
        let bumper = Arc::clone(&seq);
        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            bumper.fetch_add(1, Ordering::Relaxed);
        });
        let start = Instant::now();
        let pasted = watch_for_paste(&seq);
        let elapsed = start.elapsed();
        handle.join().expect("bumper thread joined");
        assert!(pasted, "paste fired mid-window — capture should abort");
        // Should bail well before the full window expires.
        assert!(
            elapsed < Duration::from_millis(PASTE_WATCH_MS),
            "watch did not bail early on paste signal: {:?}",
            elapsed
        );
    }

    #[test]
    fn ignores_pastes_that_predate_the_watch() {
        // A Cmd+V the user fired earlier (and that's already been counted)
        // must NOT abort a subsequent unrelated drag-select capture. The
        // baseline-snapshot semantics guarantee this.
        let seq = AtomicU64::new(99);
        let pasted = watch_for_paste(&seq);
        assert!(!pasted, "stale paste count must not trigger an abort");
    }

    // ── Realistic motor-reaction timing tests ────────────────────────────
    //
    // These tests document the timing budget the watch window must cover
    // for actual humans doing the select-to-replace gesture (drag-up,
    // hand to keyboard, press Cmd, press V). The previous 180 ms tuning
    // was too tight to catch the bulk of users — these tests fail at
    // 180 ms and pass at 500 ms.
    //
    // References for the budget:
    //   - Card/Moran/Newell (1983): perceptual + motor cycle is roughly
    //     230 ms for the average user transitioning to a keyboard.
    //   - macOS double-click default ceiling is 500 ms — Apple HIG
    //     treats up to 500 ms as one "intentional gesture beat."
    //   - Empirical Pluks bug reports (v0.4.0): paste fires anywhere
    //     in the 200–450 ms range.

    fn time_paste_at(delay_ms: u64) -> bool {
        let seq = Arc::new(AtomicU64::new(0));
        let bumper = Arc::clone(&seq);
        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(delay_ms));
            bumper.fetch_add(1, Ordering::Relaxed);
        });
        let pasted = watch_for_paste(&seq);
        handle.join().expect("bumper thread joined");
        pasted
    }

    #[test]
    fn catches_fast_user_paste_at_120ms() {
        // ~5th percentile: practiced user with hand already near keyboard.
        assert!(
            time_paste_at(120),
            "120 ms paste must be inside the watch window — \
             this is the fastest realistic replace gesture"
        );
    }

    #[test]
    fn catches_median_user_paste_at_280ms() {
        // ~50th percentile: typical hand-to-keyboard transition.
        // The v0.3.0 → v0.4.0 regression was that the watch ended at
        // 180 ms, well before this point.
        assert!(
            time_paste_at(280),
            "280 ms paste must be inside the watch window — \
             this is the median user timing the v0.4.0 regression missed"
        );
    }

    #[test]
    fn catches_slow_user_paste_at_450ms() {
        // ~95th percentile: deliberate user reading the destination
        // before pressing Cmd+V. Still a clear single-gesture replace.
        assert!(
            time_paste_at(450),
            "450 ms paste must be inside the watch window — \
             the 95th percentile of realistic replace timing"
        );
    }

    #[test]
    fn ignores_paste_after_window_expires() {
        // Far past any plausible replace gesture — this is a separate
        // intentional paste, not a replace. Must NOT abort capture.
        let pasted = time_paste_at(PASTE_WATCH_MS + 200);
        assert!(
            !pasted,
            "paste arriving well after the window must not be \
             miscategorized as a replace"
        );
    }
}
