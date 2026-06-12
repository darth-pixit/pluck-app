/// Best-effort stderr diagnostics. `eprintln!` PANICS when the stderr write
/// fails — fatal when stderr is a pipe whose reader has gone away. The Windows
/// smoke harness proved this the hard way: its launch step's pipe pump died
/// with the parent shell, the next poller heartbeat write panicked, the panic
/// hook's own eprintln panicked in turn, and the whole app aborted without a
/// trace. Real users can reproduce the same with any launcher that closes
/// stderr. Every diagnostic in this crate goes through here so logging can
/// never take the app down.
#[macro_export]
macro_rules! elog {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        let _ = writeln!(std::io::stderr().lock(), $($arg)*);
    }};
}

mod history;
mod paste;
mod selection;
mod settings;

use history::{Database, HistoryItem};
use selection::{
    activate_pid, ax_is_trusted, clipboard_change_token, clipboard_is_concealed, cursor_pos,
    focus_is_secure_field, frontmost_pid, input_monitoring_granted, read_clipboard,
    request_accessibility, request_input_monitoring, simulate_copy, simulate_paste, start_listener,
    write_clipboard, Clipboard, ManualCopySignal, MouseEvent, SelectionSignal,
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
// Emitted by `record_history` for clips the activation tour banks directly.
// Distinct from `new-selection` on purpose: the frontend updates its list
// from this but must NOT run the capture/nudge pipeline, since onboarding
// selections are not real captures.
const EVT_HISTORY_ADDED: &str = "history-added";
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
const TRAY_TEST_PASTE_CONFIRM: &str = "test_paste_confirm";
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
    /// The last clipboard text Pluks itself recorded or wrote. Shared
    /// between every path that touches the clipboard — the select-to-copy
    /// processor, the clipboard poller, long-press paste, and the
    /// copy-from-history commands — so the poller can tell a genuine
    /// external copy apart from an echo of Pluks's own write. Without it,
    /// clicking a history item to re-copy it would round-trip back through
    /// the poller and pile up duplicate rows.
    pub last_recorded_clip: Arc<Mutex<Option<String>>>,
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
    /// Remember `text` as the most recent clipboard value Pluks is responsible
    /// for, so the poller treats a subsequent clipboard change to the same
    /// value as an echo of our own write rather than a fresh external copy.
    fn remember_clip(&self, text: &str) {
        *self.last_recorded_clip.lock().unwrap_or_else(|p| p.into_inner()) = Some(text.to_string());
    }
    fn last_recorded_clip(&self) -> Option<String> {
        self.last_recorded_clip.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    /// Write `text` to the system clipboard AND stamp it as Pluks-originated in
    /// one step, closing the race where the poller could observe the change
    /// before we recorded that we caused it.
    fn write_clipboard_remembered(&self, text: &str) -> bool {
        self.remember_clip(text);
        write_clipboard(text)
    }
}

/// Insert `text` into history, stamp it as the last recorded clip, and
/// broadcast `history-added` so the live panel updates. The single entry point
/// for clips that are already on the OS clipboard but not yet in history —
/// shared by the clipboard poller, the onboarding-tour `record_history`
/// command, and the long-press fresh-clipboard path (`paste::try_fire`).
/// Insert is top-row deduped, so racing callers recording the same clip
/// collapse to one row.
pub(crate) fn record_clip(
    app: &AppHandle,
    state: &AppState,
    text: &str,
) -> rusqlite::Result<HistoryItem> {
    let item = state.db().insert(text)?;
    state.remember_clip(&item.content);
    let _ = app.emit(EVT_HISTORY_ADDED, &item);
    Ok(item)
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn get_history(state: State<Arc<AppState>>) -> Vec<HistoryItem> {
    state.db().get_all().unwrap_or_default()
}

#[tauri::command]
fn copy_item(id: i64, state: State<Arc<AppState>>) -> bool {
    let text = state.db().get_content_by_id(id).ok().flatten();
    // Stamp as Pluks-originated so the clipboard poller doesn't observe this
    // re-copy as a fresh external clip and re-insert (which would duplicate the
    // row and bump it to the top just for clicking it).
    text.map(|t| state.write_clipboard_remembered(&t)).unwrap_or(false)
}

/// Push arbitrary text onto the clipboard. Used by smart-paste detectors that
/// need to paste a transformed variant of a history item (pretty JSON, markdown
/// link, rgb() form of a hex color, etc.) rather than the raw stored content.
#[tauri::command]
fn copy_text(text: String, state: State<Arc<AppState>>) -> bool {
    // Remembered for the same reason as `copy_item`: this is a Pluks-initiated
    // write, not an external copy, so the poller should leave it alone.
    state.write_clipboard_remembered(&text)
}

/// Record a clip into history directly from the frontend and broadcast it on
/// the `history-added` channel so the live panel updates.
///
/// The background copy processor skips capture whenever the history panel is
/// visible (see `start_copy_processor`). During the activation tour the panel
/// *is* the visible window, so the sample clips the user copies while learning
/// the gesture would otherwise never make it into history — leaving them with
/// an empty panel the moment onboarding ends. This command lets the tour bank
/// those clips itself. Insert is top-row deduped, so calling it repeatedly for
/// the same text (the tour fires on every `selectionchange`) is a no-op after
/// the first landing.
///
/// We deliberately emit `history-added` rather than `new-selection`: the latter
/// drives the affirmation / hold-discovery nudge pipeline and bumps the
/// adoption counters, none of which should run for onboarding samples (it would
/// inflate `selects_total` and pop nudge pills over the tour).
#[tauri::command]
fn record_history(app: AppHandle, state: State<Arc<AppState>>, text: String) -> Option<HistoryItem> {
    // `record_clip` stamps the last recorded clip, which keeps the poller from
    // re-emitting this one: the tour already put it on the clipboard, and
    // we're recording it here.
    record_clip(&app, &state, &text).ok()
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
/// and the tray "Test Nudge" diagnostic action.
fn show_nudge_impl(app: &AppHandle, state: &Arc<AppState>, kind: &str, text: &str) {
    let (cx, cy) = cursor_pos();
    show_in_nudge_window(
        app,
        state,
        cx + NUDGE_OFFSET_X,
        cy + NUDGE_OFFSET_Y,
        EVT_NUDGE_SHOW,
        serde_json::json!({ "kind": kind, "text": text }),
        NUDGE_LIFETIME_MS,
        "show_nudge",
    );
}

/// Anchor the nudge window at the press point and broadcast a
/// `paste-confirm` event. The pill is rendered by `NudgeView`; App.tsx
/// also listens on the broadcast for analytics + the hold-discovery
/// counter bump.
pub(crate) fn show_paste_confirm(
    app: &AppHandle,
    state: &Arc<AppState>,
    x: f64,
    y: f64,
    char_count: usize,
) {
    show_in_nudge_window(
        app,
        state,
        x - PASTE_CONFIRM_OFFSET_X,
        y + PASTE_CONFIRM_OFFSET_Y,
        EVT_PASTE_CONFIRM,
        serde_json::json!({ "x": x, "y": y, "char_count": char_count }),
        PASTE_CONFIRM_LIFETIME_MS,
        "show_paste_confirm",
    );
}

/// Position + show the nudge window, broadcast `event` with `payload`,
/// and schedule a hide after `lifetime_ms`. The generation counter
/// guarantees a follow-up call within the lifetime window leaves the
/// in-flight pill on screen instead of being yanked by the prior hide
/// task. Every step is logged via `eprintln!` so the v0.4.5 diagnostic
/// build surfaces which point of the pipeline succeeds and which fails
/// — visible in Console.app under "Pluks". Filter with:
/// `process == "Pluks" && message CONTAINS "[pluks]"`.
fn show_in_nudge_window(
    app: &AppHandle,
    state: &Arc<AppState>,
    pos_x: f64,
    pos_y: f64,
    event: &str,
    payload: serde_json::Value,
    lifetime_ms: u64,
    log_tag: &str,
) {
    let Some(win) = app.get_webview_window(WIN_NUDGE) else {
        crate::elog!("[pluks] {}: WIN_NUDGE not found", log_tag);
        return;
    };
    let my_gen = state.nudge_gen.fetch_add(1, Ordering::SeqCst) + 1;
    crate::elog!(
        "[pluks] {}: gen={} target=({:.1},{:.1}) size=({},{}) event={}",
        log_tag, my_gen, pos_x, pos_y, NUDGE_WIDTH, NUDGE_HEIGHT, event,
    );
    if let Err(e) = win.set_position(tauri::LogicalPosition::new(pos_x, pos_y)) {
        crate::elog!("[pluks] {}: set_position failed: {:?}", log_tag, e);
    }
    if let Err(e) = win.set_size(tauri::LogicalSize::new(NUDGE_WIDTH, NUDGE_HEIGHT)) {
        crate::elog!("[pluks] {}: set_size failed: {:?}", log_tag, e);
    }
    if let Err(e) = win.show() {
        crate::elog!("[pluks] {}: show() failed: {:?}", log_tag, e);
    }
    // CRITICAL: Pluks is an LSUIElement/Accessory app, so it is almost never
    // the active app when a nudge fires (the user is typing in some other
    // app). `win.show()` maps to `orderFront:`, which AppKit ignores for an
    // inactive app — so the nudge window never actually came to the front
    // and never composited. orderFrontRegardless brings it up regardless of
    // active state. make_key=false: the pill is click-through and must never
    // steal keystrokes from the field the user is typing in.
    order_front_regardless(&win, false);
    // Broadcast — App.tsx in the history window may need to listen too
    // (paste-confirm), and listeners in the nudge webview itself also
    // receive broadcasts.
    if let Err(e) = app.emit(event, &payload) {
        crate::elog!("[pluks] {}: emit({}) failed: {:?}", log_tag, event, e);
    }

    let app_for_hide = app.clone();
    let gen_arc = state.nudge_gen.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(lifetime_ms));
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

// Hand the user's default mail client a pre-filled draft to support. The
// anon_id is folded into the subject so it's the first thing we see when the
// mail lands — no need to ask "what's your ID?" in the first reply.
#[tauri::command]
fn open_support_email(anon_id: String) {
    let subject = format!("Pluks support [{}]", anon_id);
    let encoded_subject = url_encode(&subject);
    let url = format!("mailto:parth.dixit@alumni.iitd.ac.in?subject={}", encoded_subject);

    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&url).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn();
    }
}

// Minimal percent-encoding for the bits of a mailto subject that would break
// argv parsing or RFC 6068 parsing (spaces, brackets, &, etc.). Pulling in
// the `url` crate just for this would be overkill.
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
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
fn order_front_regardless<R: Runtime>(window: &WebviewWindow<R>, make_key: bool) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let Ok(ns) = window.ns_window() else { return };
    if ns.is_null() { return; }
    let ns = ns as *mut AnyObject;

    // For a NonactivatingPanel we deliberately do NOT call
    // activateIgnoringOtherApps — that would yank the user out of the
    // foreground app's full-screen Space. orderFrontRegardless brings the
    // panel up *even though Pluks is an LSUIElement/Accessory app that is
    // never the active app* — plain `orderFront:` (what window.show() maps
    // to) is a no-op for an inactive app, which is exactly why the nudge
    // overlay never composited.
    //
    // `make_key` controls makeKeyAndOrderFront: the history panel needs it
    // to receive keystrokes; the click-through ambient nudge must NOT take
    // it, or it would steal keys from the field the user is typing in.
    unsafe {
        let _: () = msg_send![ns, orderFrontRegardless];
        if make_key {
            let _: () = msg_send![ns, makeKeyAndOrderFront: std::ptr::null_mut::<AnyObject>()];
        }
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
fn order_front_regardless<R: Runtime>(window: &WebviewWindow<R>, make_key: bool) {
    // The click-through nudge overlay passes make_key=false and must never
    // grab focus; only the history panel asks for it.
    if make_key {
        let _ = window.set_focus();
    }
}

fn show_history_window<R: Runtime>(window: &WebviewWindow<R>, keyboard: bool) {
    let _ = window.center();
    let _ = window.show();
    order_front_regardless(window, true);
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
                        // Stamp before notifying so the poller treats the
                        // synthetic-copy clipboard change as an echo of this
                        // capture, not a second external clip.
                        state.remember_clip(&item.content);
                        let _ = app_handle.emit(EVT_NEW_SELECTION, &item);
                    }
                }
            }
        }
    });
}

// ── Clipboard poller ────────────────────────────────────────────────────────────
//
// The select-to-copy path only records gestures Pluks recognizes (drag,
// multi-click, Cmd/Ctrl+A). Everything else that reaches the system clipboard —
// a manual Cmd+C / Ctrl+C, right-click → Copy, a "Copy" button, a copy from
// another app entirely — would otherwise never enter history, so it wouldn't
// show in the panel and long-press would paste a stale clip. This poller is the
// source-agnostic catch-all: it watches the OS clipboard and records any new
// distinct text, regardless of how it got there.
//
// It is deliberately independent of the Accessibility / Input Monitoring grants
// (it only reads the clipboard, never synthesizes input), so manual copies are
// captured even on a machine where the select-to-copy gesture can't run — and
// it is the only capture path that works under Wayland.

const CLIPBOARD_POLL_MS: u64 = 500;

#[derive(Debug, PartialEq)]
enum PollOutcome {
    Skip(&'static str),
    Record(String),
}

/// Pure decision for one poll tick. Split out so the full suppression matrix is
/// unit-testable without a clipboard, a database, or Tauri. The platform reads
/// (change token, concealed flag, clipboard text) happen in the loop and are
/// passed in here.
///
/// Precedence is intentional: `enabled` and `panel_visible` are *transient
/// external* states (the user paused Pluks, or has the panel open) and are
/// checked first; `concealed` is a privacy hard-stop; then content-tied
/// reasons. The caller uses the reason string to decide whether to consume the
/// change token (see the loop).
fn decide_poll(
    enabled: bool,
    panel_visible: bool,
    concealed: bool,
    clipboard_text: Option<String>,
    last_recorded: Option<&str>,
) -> PollOutcome {
    if !enabled {
        return PollOutcome::Skip("disabled");
    }
    if panel_visible {
        return PollOutcome::Skip("panel_visible");
    }
    if concealed {
        return PollOutcome::Skip("concealed");
    }
    let Some(text) = clipboard_text else {
        return PollOutcome::Skip("empty");
    };
    if last_recorded == Some(text.as_str()) {
        return PollOutcome::Skip("unchanged");
    }
    PollOutcome::Record(text)
}

fn start_clipboard_poller(state: Arc<AppState>, app_handle: AppHandle) {
    thread::spawn(move || {
        // One reused arboard handle, like the copy processor.
        let mut clip: Option<Clipboard> = Clipboard::new().ok();
        let mut last_token = clipboard_change_token();
        // Dedupe for the skip-reason diagnostic below: transient skip reasons
        // (disabled / panel_visible) don't consume the change token, so they
        // re-fire every tick — log only the transitions.
        let mut last_skip_reason: Option<&'static str> = None;
        // Set PLUKS_POLL_DEBUG=1 (the windows-smoke workflow does) for a
        // per-stage trace of each tick. The "poller online" line is
        // unconditional: it's one line per app start and it's the proof that
        // this thread exists and what change token it baselined — without it
        // a silent capture stall is indistinguishable from a dead thread.
        // "0" and empty mean OFF — a bare `is_ok()` would treat an explicit
        // disable as enable.
        let debug = std::env::var("PLUKS_POLL_DEBUG")
            .map(|v| !v.is_empty() && v != "0")
            .unwrap_or(false);
        crate::elog!("[pluks] clipboard poller online, initial token {last_token:?}");
        let mut tick: u64 = 0;
        // Clip whose DB insert failed, awaiting retry — decoupled from the
        // clipboard token so no later skip can consume its way past it.
        let mut pending_insert: Option<String> = None;

        loop {
            thread::sleep(Duration::from_millis(CLIPBOARD_POLL_MS));
            tick += 1;

            // Retry a previously failed insert before looking at the
            // clipboard at all: the text was already read and approved by
            // the privacy gate on the tick that captured it.
            if let Some(t) = pending_insert.take() {
                match state.db().insert(&t) {
                    Ok(item) => {
                        state.remember_clip(&item.content);
                        let _ = app_handle.emit(EVT_HISTORY_ADDED, &item);
                        last_skip_reason = None;
                    }
                    Err(_) => pending_insert = Some(t),
                }
            }

            // Cheap change gate: when the platform exposes a sequence number
            // and it hasn't advanced, nothing was copied — skip the expensive
            // type inspection and text read entirely. Platforms without a token
            // (Linux) report `None` and always fall through to a content check.
            let token = clipboard_change_token();
            if debug && tick % 10 == 0 {
                // Heartbeat (5s cadence): proves the loop is alive and shows
                // the raw token even when the gate below never opens — the
                // frozen-token failure mode (e.g. GetClipboardSequenceNumber
                // returning 0 without window-station access) is invisible to
                // every other log line.
                crate::elog!("[pluks] poll heartbeat tick={tick} token={token:?} last={last_token:?}");
            }
            let changed = match (token, last_token) {
                (Some(t), Some(lt)) => t != lt,
                _ => true,
            };
            if !changed {
                continue;
            }
            if debug {
                crate::elog!("[pluks] poll: token changed {last_token:?} -> {token:?}");
            }

            // Privacy gate FIRST: if the clipboard is flagged concealed we never
            // read the text, so a copied password never enters a String, the DB,
            // or the live panel.
            let mut concealed = clipboard_is_concealed();
            if debug {
                crate::elog!("[pluks] poll: concealed={concealed}");
            }
            let text = if concealed {
                None
            } else {
                // One bounded retry: `read_clipboard` flattens transient
                // failures (another process briefly holding the clipboard
                // open, delayed rendering) into the same `None` as a
                // genuinely text-less clipboard, and a `None` outcome
                // consumes the change token below — without the retry, one
                // moment of contention permanently loses that copy.
                read_clipboard(&mut clip).or_else(|| {
                    // Only on platforms WITH a change token: on Linux
                    // `changed` is always true, so the next 500ms tick
                    // retries naturally — sleeping here would add a 50ms nap
                    // and a doubled read to every tick a non-text clip
                    // (screenshot, file) sits on the clipboard.
                    if token.is_none() {
                        return None;
                    }
                    thread::sleep(Duration::from_millis(50));
                    // Re-run the privacy gate before the second read: a
                    // failed first read means some process was mid-write —
                    // plausibly a password manager. Reading under the stale
                    // pre-sleep verdict would capture a concealed secret
                    // written during the nap.
                    concealed = clipboard_is_concealed();
                    if concealed {
                        None
                    } else {
                        read_clipboard(&mut clip)
                    }
                })
            };
            if debug {
                crate::elog!("[pluks] poll: text_len={:?}", text.as_ref().map(|t| t.len()));
            }
            let visible = panel_visible(&app_handle);
            if debug {
                crate::elog!("[pluks] poll: panel_visible={visible}");
            }

            let outcome = decide_poll(
                state.watcher_enabled(),
                visible,
                concealed,
                text,
                state.last_recorded_clip().as_deref(),
            );

            match outcome {
                // `record_clip` emits `history-added`, not `new-selection`:
                // this updates the panel list but must NOT run the
                // affirmation/nudge pipeline or inflate the select-to-copy
                // adoption counters — a manual copy isn't a select-to-copy.
                PollOutcome::Record(t) => match record_clip(&app_handle, &state, &t) {
                    Ok(_) => {
                        last_token = token;
                        last_skip_reason = None;
                    }
                    Err(e) => {
                        // Stash the approved text and retry the INSERT next
                        // tick (SQLITE_BUSY from a concurrent reader and
                        // transient IOERR are recoverable). The token IS
                        // consumed: the clip is preserved in the stash, and
                        // tying the retry to an unconsumed token would let an
                        // unrelated Skip("empty") on the next tick consume it
                        // and silently abandon the clip. Dedupe the log line
                        // so a persistent failure (disk full) doesn't spam
                        // stderr twice a second.
                        if last_skip_reason != Some("db_insert_failed") {
                            crate::elog!("[pluks] history insert failed (will retry): {e}");
                            last_skip_reason = Some("db_insert_failed");
                        }
                        pending_insert = Some(t);
                        last_token = token;
                    }
                },
                PollOutcome::Skip(reason) => {
                    // Log skip-state transitions (not every tick — transient
                    // reasons re-fire until the block clears). This is the
                    // only visibility into why a copy never reached history;
                    // the Windows smoke run that caught the panel_visible
                    // startup stall was undiagnosable without it.
                    if last_skip_reason != Some(reason) {
                        crate::elog!("[pluks] clipboard poll skip: {reason}");
                        last_skip_reason = Some(reason);
                    }
                    // Consume the token only for content-tied reasons so we
                    // don't re-inspect the same clipboard every tick. For
                    // transient external blocks (auto-copy disabled, panel
                    // open) leave it unconsumed so the clip is captured the
                    // moment the block clears.
                    if !matches!(reason, "disabled" | "panel_visible") {
                        last_token = token;
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
    crate::elog!(
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
                last_recorded_clip: Arc::new(Mutex::new(None)),
            });
            app.manage(state.clone());

            // ── Tray ─────────────────────────────────────────────────────
            // The ENTIRE tray block — menu items, menu, icon, registration —
            // is fallible-but-not-fatal: menu construction can fail in the
            // same shell-less/display-less situations as Shell_NotifyIcon
            // (the original motivation below), and a missing tray must never
            // take clipboard capture and the global shortcut down with it.
            let tray_result = (|| -> tauri::Result<()> {
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
            // Diagnostic actions (v0.4.5). Bypass the capture / long-press
            // pipelines and fire the overlay show paths directly so the user
            // can verify whether the pill actually renders — independently
            // of whether a real selection / hold made it through capture.
            // "Test Paste Confirm" is the on-demand way to verify the
            // silent-paste pill composites over fullscreen apps without
            // having to trigger a real long-press from inside one.
            let test_nudge_item = MenuItem::with_id(
                app,
                TRAY_TEST_NUDGE,
                "Test Nudge (debug)",
                true,
                None::<&str>,
            )?;
            let test_paste_confirm_item = MenuItem::with_id(
                app,
                TRAY_TEST_PASTE_CONFIRM,
                "Test Paste Confirm (debug)",
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
                    &test_paste_confirm_item,
                    &quit_item,
                ],
            )?;

            // Tray registration talks to the shell (`Shell_NotifyIcon` on
            // Windows, StatusNotifier on Linux) and can fail when no shell is
            // available — explorer.exe crashing/restarting, headless CI
            // sessions.
            let mut builder = TrayIconBuilder::new();
            // No unwrap: a missing default window icon must degrade to an
            // icon-less tray, not a setup panic that the closure can't catch.
            if let Some(icon) = app.default_window_icon() {
                builder = builder.icon(icon.clone());
            }
            builder
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
                            crate::elog!("[pluks] tray: TEST_NUDGE clicked");
                            show_nudge_impl(
                                &app_handle,
                                &state_ref,
                                "affirmation",
                                "✦ Test nudge",
                            );
                        }
                        TRAY_TEST_PASTE_CONFIRM => {
                            crate::elog!("[pluks] tray: TEST_PASTE_CONFIRM clicked");
                            let (cx, cy) = cursor_pos();
                            show_paste_confirm(&app_handle, &state_ref, cx, cy, 42);
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
            Ok(())
            })();
            if let Err(e) = tray_result {
                crate::elog!("[pluks] tray setup failed (continuing without tray): {e}");
            }

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
                    crate::elog!("[pluks] failed to register Cmd+Shift+V: {:?}", e);
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
                        crate::elog!("[pluks] failed to register {}: {:?}", combo, e);
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
            // Source-agnostic clipboard history capture (manual Cmd+C, copy
            // buttons, cross-app copies). Independent of the input-listener
            // permissions, so it must be started even when those aren't granted.
            start_clipboard_poller(state.clone(), app.handle().clone());
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
            // — that's the intended invisible-launch default. The else branch
            // *enforces* hidden rather than assuming it: on Windows the old
            // `visible: false` + `focus: true` combination in tauri.conf.json
            // left the freshly created window showing, which both put a
            // stray panel on screen and permanently stalled the clipboard
            // poller (`decide_poll` skips every tick with "panel_visible").
            // The config now ships `focus: false` (the root fix); this hide
            // is belt-and-suspenders against any future creation-time quirk.
            // Hiding an already-hidden window is a no-op, so it's safe on
            // macOS/Linux too.
            if !ax_is_trusted() || !input_monitoring_granted() {
                if let Some(win) = app.get_webview_window(WIN_HISTORY) {
                    show_history_window(&win, false);
                }
            } else if let Some(win) = app.get_webview_window(WIN_HISTORY) {
                // Only log when something was actually wrong: this line is the
                // grep target for the visible-at-startup bug, and printing it
                // on every healthy launch would bury the real occurrence.
                if win.is_visible().unwrap_or(false) {
                    crate::elog!("[pluks] history window visible at startup — forcing hidden");
                }
                let _ = win.hide();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_history,
            copy_item,
            copy_text,
            record_history,
            delete_item,
            clear_history,
            check_accessibility,
            check_input_monitoring,
            open_accessibility_settings,
            open_input_monitoring_settings,
            open_support_email,
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

#[cfg(test)]
mod poll_tests {
    use super::{decide_poll, PollOutcome};

    fn text(s: &str) -> Option<String> {
        Some(s.to_string())
    }

    // ── The happy path ────────────────────────────────────────────────────

    #[test]
    fn records_a_fresh_external_copy() {
        // Manual Cmd+C of brand-new text with nothing previously recorded.
        let out = decide_poll(true, false, false, text("hello"), None);
        assert_eq!(out, PollOutcome::Record("hello".into()));
    }

    #[test]
    fn records_when_clipboard_differs_from_last_recorded() {
        // Pluks last recorded "old"; the user has since copied "new" elsewhere.
        let out = decide_poll(true, false, false, text("new"), Some("old"));
        assert_eq!(out, PollOutcome::Record("new".into()));
    }

    // ── Echo suppression ──────────────────────────────────────────────────

    #[test]
    fn skips_echo_of_pluks_own_write() {
        // The clipboard matches what Pluks just wrote/recorded — clicking a
        // history item, a long-press paste, or the synthetic-copy capture. Must
        // NOT round-trip back into a duplicate row.
        let out = decide_poll(true, false, false, text("same"), Some("same"));
        assert_eq!(out, PollOutcome::Skip("unchanged"));
    }

    // ── Privacy hard-stop ─────────────────────────────────────────────────

    #[test]
    fn skips_concealed_clipboard() {
        // Password manager flagged the clip; the loop passes text=None because
        // it never reads concealed content, but even if text leaked through we
        // must still skip.
        assert_eq!(
            decide_poll(true, false, true, None, None),
            PollOutcome::Skip("concealed")
        );
        assert_eq!(
            decide_poll(true, false, true, text("hunter2"), None),
            PollOutcome::Skip("concealed")
        );
    }

    #[test]
    fn concealed_beats_a_genuinely_new_value() {
        // Even brand-new, never-before-seen text is dropped when concealed.
        let out = decide_poll(true, false, true, text("brand new secret"), Some("old"));
        assert_eq!(out, PollOutcome::Skip("concealed"));
    }

    // ── Transient external blocks ─────────────────────────────────────────

    #[test]
    fn skips_when_auto_copy_disabled() {
        // `disabled` wins over everything, including a fresh value — the user
        // paused Pluks. The loop leaves the change token unconsumed on this
        // reason so the clip is still captured if they re-enable.
        let out = decide_poll(false, false, false, text("fresh"), None);
        assert_eq!(out, PollOutcome::Skip("disabled"));
    }

    #[test]
    fn disabled_takes_precedence_over_concealed_and_panel() {
        let out = decide_poll(false, true, true, text("x"), None);
        assert_eq!(out, PollOutcome::Skip("disabled"));
    }

    #[test]
    fn skips_when_panel_visible() {
        // Panel open (incl. the activation tour, which records via
        // `record_history` instead). Transient — token left unconsumed.
        let out = decide_poll(true, true, false, text("fresh"), None);
        assert_eq!(out, PollOutcome::Skip("panel_visible"));
    }

    #[test]
    fn panel_takes_precedence_over_concealed() {
        let out = decide_poll(true, true, true, text("x"), None);
        assert_eq!(out, PollOutcome::Skip("panel_visible"));
    }

    // ── Empty / no-text clipboard ─────────────────────────────────────────

    #[test]
    fn skips_when_clipboard_has_no_text() {
        // Image/file copy, or `read_clipboard` filtered an all-whitespace clip.
        let out = decide_poll(true, false, false, None, Some("prev"));
        assert_eq!(out, PollOutcome::Skip("empty"));
    }

    // ── Token-consumption contract the loop depends on ────────────────────
    //
    // The loop consumes the change token for every reason EXCEPT "disabled"
    // and "panel_visible" (so a clip copied during a transient block is still
    // captured once it clears). These tests pin which reason strings drive
    // that branch, so a future rename can't silently break the behavior.

    fn reason(out: &PollOutcome) -> &'static str {
        match out {
            PollOutcome::Skip(r) => r,
            PollOutcome::Record(_) => "record",
        }
    }

    #[test]
    fn transient_block_reasons_are_exactly_disabled_and_panel() {
        assert_eq!(
            reason(&decide_poll(false, false, false, text("a"), None)),
            "disabled"
        );
        assert_eq!(
            reason(&decide_poll(true, true, false, text("a"), None)),
            "panel_visible"
        );
        // Everything else is a content-tied reason the loop consumes the token
        // for, so it isn't re-inspected every tick.
        for r in [
            reason(&decide_poll(true, false, true, None, None)),
            reason(&decide_poll(true, false, false, None, None)),
            reason(&decide_poll(true, false, false, text("a"), Some("a"))),
        ] {
            assert!(
                !matches!(r, "disabled" | "panel_visible"),
                "reason {r:?} must not be treated as a transient block"
            );
        }
    }
}
