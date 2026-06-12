use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

pub struct SelectionSignal;

/// User pressed the platform copy shortcut explicitly (Cmd+C / Ctrl+C).
/// Used by `manual_copy_processor` in lib.rs to track the user's habit
/// of double-confirming with Cmd+C even after Pluks has already grabbed
/// the selection. Also catches our own `simulate_copy()` synthetic
/// Cmd+C — lib.rs filters those via a synthetic-copy timestamp.
pub struct ManualCopySignal;

/// Low-level left-mouse stream forwarded to `paste.rs`, which derives the
/// long-press gesture from it. The `Move` variant only fires while the
/// button is down — we don't care about hover motion. Coordinates are in
/// the same screen space `cursor_pos()` returns (logical pixels on macOS,
/// physical pixels on Windows; the nudge window's position units match).
pub enum MouseEvent {
    Down { x: f64, y: f64 },
    Move { x: f64, y: f64 },
    Up,
}

const DRAG_PIXEL_THRESHOLD: f64 = 4.0;
const MULTI_CLICK_MIN_GAP_MS: u128 = 30;
const MULTI_CLICK_MAX_GAP_MS: u128 = 600;

#[cfg(target_os = "macos")]
const KEYCODE_C: u16 = 8;
#[cfg(target_os = "macos")]
const KEYCODE_V: u16 = 9;
#[cfg(target_os = "macos")]
const KEYCODE_A: i64 = 0;

macro_rules! dlog {
    ($($arg:tt)*) => {
        #[cfg(debug_assertions)]
        crate::elog!($($arg)*);
    };
}

// ── macOS: permission checks ───────────────────────────────────────────────────

// IOHIDRequestType enum from <IOKit/hid/IOHIDLib.h>:
//   kIOHIDRequestTypeListenEvent = 0 — global event-tap listener
//                                       (this is the Input Monitoring grant)
//   kIOHIDRequestTypePostEvent   = 1 — event synthesis
//                                       (already covered by Accessibility)
//
// We need ListenEvent: Pluks installs a CGEventTap on kCGHIDEventTap to LISTEN
// for the user's selection/copy gestures. Passing PostEvent here is a silent
// bug — `IOHIDCheckAccess(1)` returns Granted whenever Accessibility is
// granted (because AX covers event posting), so the UI shows ✓ Granted even
// when Pluks isn't in the Input Monitoring list and the event tap is dead.
// Symmetrically, `IOHIDRequestAccess(1)` prompts for post-event access — it
// does NOT add the app to the Input Monitoring list, which is why "Grant →"
// previously landed users on an Input Monitoring pane that didn't contain
// Pluks at all.
#[cfg(target_os = "macos")]
const K_IO_HID_REQUEST_TYPE_LISTEN_EVENT: u32 = 0;

#[cfg(target_os = "macos")]
pub fn ax_is_trusted() -> bool {
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }
    unsafe { AXIsProcessTrusted() }
}

#[cfg(target_os = "macos")]
pub fn input_monitoring_granted() -> bool {
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOHIDCheckAccess(request_type: u32) -> i32;
    }
    unsafe { IOHIDCheckAccess(K_IO_HID_REQUEST_TYPE_LISTEN_EVENT) == 0 }
}

// Actively asks macOS for Accessibility permission. Unlike `AXIsProcessTrusted`,
// `AXIsProcessTrustedWithOptions` with `kAXTrustedCheckOptionPrompt=true` adds
// the app to the System Settings → Accessibility list (if not already present)
// and surfaces the standard "X would like to control your computer" prompt.
// Without this we can't recover if the user removes Pluks from the list — the
// passive check would loop forever and the in-app "Open Settings" button would
// land them on a panel that no longer contains Pluks.
//
// Returns the current trust state. The user's grant (when given) only takes
// effect on the next process launch, so we still poll `ax_is_trusted()` from
// `start_listener` for the live update.
#[cfg(target_os = "macos")]
pub fn request_accessibility() -> bool {
    use std::ffi::c_void;
    use std::ptr;

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type CFDictionaryRef = *const c_void;

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: CFTypeRef);
        fn CFStringCreateWithBytes(
            alloc: CFTypeRef,
            bytes: *const u8,
            num_bytes: isize,
            encoding: u32,
            is_external_representation: u8,
        ) -> CFStringRef;
        fn CFDictionaryCreate(
            allocator: CFTypeRef,
            keys: *const *const c_void,
            values: *const *const c_void,
            num_values: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> CFDictionaryRef;
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
        static kCFBooleanTrue: CFTypeRef;
    }

    // Same workaround as `focus_is_secure_field`: don't try to extern-static
    // the kAX* CFString constant — its symbol resolution is unreliable through
    // the umbrella framework. Build the CFString from the documented literal
    // ("AXTrustedCheckOptionPrompt") and the AX API will compare it by value.
    unsafe {
        let key_bytes = b"AXTrustedCheckOptionPrompt";
        let key = CFStringCreateWithBytes(
            ptr::null(),
            key_bytes.as_ptr(),
            key_bytes.len() as isize,
            K_CF_STRING_ENCODING_UTF8,
            0,
        );
        if key.is_null() {
            return AXIsProcessTrustedWithOptions(ptr::null());
        }
        let keys = [key];
        let values = [kCFBooleanTrue];
        let opts = CFDictionaryCreate(
            ptr::null(),
            keys.as_ptr() as *const *const c_void,
            values.as_ptr() as *const *const c_void,
            1,
            &kCFTypeDictionaryKeyCallBacks as *const _ as *const c_void,
            &kCFTypeDictionaryValueCallBacks as *const _ as *const c_void,
        );
        let trusted = AXIsProcessTrustedWithOptions(opts);
        if !opts.is_null() { CFRelease(opts); }
        CFRelease(key);
        trusted
    }
}

// Actively asks macOS for Input Monitoring permission. `IOHIDCheckAccess` is a
// passive query — it never causes the OS prompt to appear, so on a fresh
// install (or after the user removes Pluks from the list) we have no way to
// re-surface the prompt without explicitly calling `IOHIDRequestAccess`.
// Returns whether access is granted right now. As with Accessibility, a grant
// only becomes observable to the in-process event tap on the next launch.
#[cfg(target_os = "macos")]
pub fn request_input_monitoring() -> bool {
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOHIDRequestAccess(request_type: u32) -> bool;
    }
    unsafe { IOHIDRequestAccess(K_IO_HID_REQUEST_TYPE_LISTEN_EVENT) }
}

// Windows & Linux don't gate global input behind a per-app permission the way
// macOS does (Accessibility / Input Monitoring). The OS either allows global
// hooks for any process or it doesn't (Wayland under most compositors blocks
// them entirely). We report "granted" so the onboarding screen doesn't appear;
// the listener itself logs if `rdev::listen` fails.
#[cfg(not(target_os = "macos"))]
pub fn ax_is_trusted() -> bool { true }

#[cfg(not(target_os = "macos"))]
pub fn input_monitoring_granted() -> bool { true }

#[cfg(not(target_os = "macos"))]
pub fn request_accessibility() -> bool { true }

#[cfg(not(target_os = "macos"))]
pub fn request_input_monitoring() -> bool { true }

// ── Secure-field focus detection ──────────────────────────────────────────────
//
// We previously suppressed auto-copy for *any* editable focus (text fields,
// text areas, search boxes, terminal views) on the theory that the user was
// about to paste-replace and we shouldn't clobber their clipboard. In
// practice this misfired on every common copy gesture inside a composer or
// terminal — users dragging to select 2–3 words in WhatsApp, copying output
// from Terminal.app, etc. — and left them stuck pasting an older value.
//
// The narrowed check returns true only for `AXSecureTextField` (password
// fields), where capturing the content would be a privacy violation. All
// other editable fields fall through to the normal capture path.

#[cfg(target_os = "macos")]
pub fn focus_is_secure_field() -> bool {
    use std::ffi::c_void;
    use std::ptr;

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type AXUIElementRef = *const c_void;
    type AXError = i32;

    const KAX_ERROR_SUCCESS: AXError = 0;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateSystemWide() -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> AXError;
        fn AXUIElementSetMessagingTimeout(
            element: AXUIElementRef,
            timeout_in_seconds: f32,
        ) -> AXError;
    }

    // We deliberately don't `extern static` the kAX* CFString constants —
    // declaring them in a function-local extern block leaves them as
    // unresolved Mach-O symbols at link time even with -framework
    // ApplicationServices on the line. We construct equivalent CFStrings
    // from their documented literal values instead; the AX APIs only care
    // about string identity, not which symbol they came from.
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: CFTypeRef);
        fn CFStringGetCString(
            s: CFStringRef,
            buffer: *mut u8,
            buffer_size: isize,
            encoding: u32,
        ) -> u8;
        fn CFStringCreateWithBytes(
            alloc: CFTypeRef,
            bytes: *const u8,
            num_bytes: isize,
            encoding: u32,
            is_external_representation: u8,
        ) -> CFStringRef;
    }

    unsafe fn make_cfstr(bytes: &[u8]) -> CFStringRef {
        CFStringCreateWithBytes(
            ptr::null(),
            bytes.as_ptr(),
            bytes.len() as isize,
            K_CF_STRING_ENCODING_UTF8,
            0,
        )
    }

    unsafe {
        let attr_focused = make_cfstr(b"AXFocusedUIElement");
        let attr_role = make_cfstr(b"AXRole");
        if attr_focused.is_null() || attr_role.is_null() {
            if !attr_focused.is_null() { CFRelease(attr_focused); }
            if !attr_role.is_null() { CFRelease(attr_role); }
            return false;
        }

        let system = AXUIElementCreateSystemWide();
        if system.is_null() {
            CFRelease(attr_focused);
            CFRelease(attr_role);
            return false;
        }
        // Cap each AX round-trip — an unresponsive target app must not stall
        // the copy processor.
        AXUIElementSetMessagingTimeout(system, 0.1);

        let mut focused: CFTypeRef = ptr::null();
        let err = AXUIElementCopyAttributeValue(system, attr_focused, &mut focused);
        CFRelease(system);

        if err != KAX_ERROR_SUCCESS || focused.is_null() {
            CFRelease(attr_focused);
            CFRelease(attr_role);
            return false;
        }
        let focused_el = focused as AXUIElementRef;
        AXUIElementSetMessagingTimeout(focused_el, 0.1);

        // Match the role exactly. AXSecureTextField is the only AX role
        // assigned to password inputs (NSSecureTextField on macOS, the
        // analogous WKWebView/CEF mapping for browsers, etc.).
        let mut role_ref: CFTypeRef = ptr::null();
        let r_err = AXUIElementCopyAttributeValue(focused_el, attr_role, &mut role_ref);
        let secure = if r_err == KAX_ERROR_SUCCESS && !role_ref.is_null() {
            let mut buf = [0u8; 64];
            let ok = CFStringGetCString(
                role_ref as CFStringRef,
                buf.as_mut_ptr(),
                buf.len() as isize,
                K_CF_STRING_ENCODING_UTF8,
            );
            CFRelease(role_ref);
            if ok != 0 {
                let nul = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
                let role = std::str::from_utf8(&buf[..nul]).unwrap_or("");
                role == "AXSecureTextField"
            } else {
                false
            }
        } else {
            false
        };

        CFRelease(focused);
        CFRelease(attr_focused);
        CFRelease(attr_role);
        secure
    }
}

// Windows + Linux: no detector yet — return false so capture proceeds in all
// focused fields, mirroring the relaxed macOS behavior post-narrowing. We can
// add UIAutomation (Win) and AT-SPI (Linux) password-field detection later.
#[cfg(not(target_os = "macos"))]
pub fn focus_is_secure_field() -> bool { false }

// ── Target-app focus tracking ─────────────────────────────────────────────────

/// PID of the frontmost application. Used to remember which app was active
/// before the panel opened, so we can reactivate it before pasting.
#[cfg(target_os = "macos")]
pub fn frontmost_pid() -> Option<i32> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    unsafe {
        extern "C" {
            fn objc_getClass(name: *const u8) -> *mut AnyObject;
        }
        let cls = objc_getClass(b"NSWorkspace\0".as_ptr());
        if cls.is_null() { return None; }
        let workspace: *mut AnyObject = msg_send![cls, sharedWorkspace];
        if workspace.is_null() { return None; }
        let app: *mut AnyObject = msg_send![workspace, frontmostApplication];
        if app.is_null() { return None; }
        let pid: i32 = msg_send![app, processIdentifier];
        if pid > 0 { Some(pid) } else { None }
    }
}

#[cfg(target_os = "macos")]
pub fn activate_pid(pid: i32) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    unsafe {
        extern "C" {
            fn objc_getClass(name: *const u8) -> *mut AnyObject;
        }
        let cls = objc_getClass(b"NSRunningApplication\0".as_ptr());
        if cls.is_null() { return; }
        let app: *mut AnyObject = msg_send![cls, runningApplicationWithProcessIdentifier: pid];
        if app.is_null() { return; }
        // NSApplicationActivateIgnoringOtherApps = 1 << 1 = 2
        let _: bool = msg_send![app, activateWithOptions: 2u64];
    }
}

// ── Windows: frontmost-app tracking via Win32 ─────────────────────────────────

#[cfg(target_os = "windows")]
pub fn frontmost_pid() -> Option<i32> {
    use std::ffi::c_void;
    extern "system" {
        fn GetForegroundWindow() -> *mut c_void;
        fn GetWindowThreadProcessId(hwnd: *mut c_void, lpdw_process_id: *mut u32) -> u32;
    }
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() { return None; }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid > 0 { Some(pid as i32) } else { None }
    }
}

#[cfg(target_os = "windows")]
pub fn activate_pid(pid: i32) {
    use std::ffi::c_void;
    extern "system" {
        fn EnumWindows(cb: extern "system" fn(*mut c_void, isize) -> i32, lparam: isize) -> i32;
        fn GetWindowThreadProcessId(hwnd: *mut c_void, lpdw_process_id: *mut u32) -> u32;
        fn IsWindowVisible(hwnd: *mut c_void) -> i32;
        fn SetForegroundWindow(hwnd: *mut c_void) -> i32;
        fn ShowWindow(hwnd: *mut c_void, cmd: i32) -> i32;
        fn IsIconic(hwnd: *mut c_void) -> i32;
    }
    const SW_RESTORE: i32 = 9;

    struct Search { target_pid: u32, found: *mut c_void }

    extern "system" fn enum_cb(hwnd: *mut c_void, lparam: isize) -> i32 {
        unsafe {
            let s = &mut *(lparam as *mut Search);
            let mut p: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut p);
            if p == s.target_pid && IsWindowVisible(hwnd) != 0 {
                s.found = hwnd;
                return 0;
            }
            1
        }
    }

    let mut search = Search { target_pid: pid as u32, found: std::ptr::null_mut() };
    unsafe {
        EnumWindows(enum_cb, &mut search as *mut _ as isize);
        if search.found.is_null() { return; }
        if IsIconic(search.found) != 0 {
            ShowWindow(search.found, SW_RESTORE);
        }
        // Note: SetForegroundWindow may be blocked by the Win32 foreground
        // lock if our process isn't currently allowed to take focus. The
        // panel typically WAS frontmost, which lets this succeed; if the lock
        // bites in practice we can mitigate with AllowSetForegroundWindow
        // from the panel just before hiding it.
        SetForegroundWindow(search.found);
    }
}

// ── Linux: frontmost-app tracking via xdotool (X11) ───────────────────────────
//
// Wayland sessions block global window-management APIs from arbitrary
// processes; on those, both calls degrade to None / no-op and paste lands
// wherever the compositor places focus next.

#[cfg(target_os = "linux")]
pub fn frontmost_pid() -> Option<i32> {
    let out = std::process::Command::new("xdotool")
        .args(["getactivewindow", "getwindowpid"])
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    std::str::from_utf8(&out.stdout).ok()?.trim().parse().ok()
}

#[cfg(target_os = "linux")]
pub fn activate_pid(pid: i32) {
    let Ok(out) = std::process::Command::new("xdotool")
        .args(["search", "--pid", &pid.to_string()])
        .output()
    else { return };
    if !out.status.success() { return; }
    let Ok(text) = std::str::from_utf8(&out.stdout) else { return };
    let Some(wid) = text.lines().next() else { return };
    let _ = std::process::Command::new("xdotool")
        .args(["windowactivate", "--sync", wid])
        .status();
}

// ── macOS: CGEvent FFI shared between cursor_pos, key sim, and the tap ─────────

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint { x: f64, y: f64 }

#[cfg(target_os = "macos")]
pub fn cursor_pos() -> (f64, f64) {
    use std::ffi::c_void;
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreate(source: *const c_void) -> *mut c_void;
        fn CGEventGetLocation(event: *const c_void) -> CGPoint;
        fn CFRelease(cf: *const c_void);
    }
    unsafe {
        let ev = CGEventCreate(std::ptr::null());
        if ev.is_null() { return (0.0, 0.0); }
        let pt = CGEventGetLocation(ev);
        CFRelease(ev);
        (pt.x, pt.y)
    }
}

// Windows: GetCursorPos returns screen coordinates in pixels — same
// space Tauri's set_position consumes when given LogicalPosition with
// the system DPI factor of 1.0. For HiDPI monitors the conversion
// happens window-side.
#[cfg(target_os = "windows")]
pub fn cursor_pos() -> (f64, f64) {
    #[repr(C)]
    struct POINT { x: i32, y: i32 }
    extern "system" {
        fn GetCursorPos(p: *mut POINT) -> i32;
    }
    let mut p = POINT { x: 0, y: 0 };
    unsafe {
        if GetCursorPos(&mut p) == 0 {
            return (0.0, 0.0);
        }
    }
    (p.x as f64, p.y as f64)
}

// Linux: shell out to `xdotool getmouselocation`. On Wayland this fails
// and we degrade to (0,0) — the nudge will land in the top-left
// corner. Acceptable: Wayland users are already the long tail.
#[cfg(target_os = "linux")]
pub fn cursor_pos() -> (f64, f64) {
    let Ok(out) = std::process::Command::new("xdotool")
        .arg("getmouselocation")
        .output()
    else { return (0.0, 0.0) };
    if !out.status.success() { return (0.0, 0.0); }
    let Ok(text) = std::str::from_utf8(&out.stdout) else { return (0.0, 0.0) };
    let mut x = 0.0_f64;
    let mut y = 0.0_f64;
    // Output format: "x:1234 y:567 screen:0 window:..."
    for tok in text.split_whitespace() {
        if let Some(v) = tok.strip_prefix("x:") { x = v.parse().unwrap_or(0.0); }
        if let Some(v) = tok.strip_prefix("y:") { y = v.parse().unwrap_or(0.0); }
    }
    (x, y)
}

// ── macOS: keyboard simulation via CGEvent ────────────────────────────────────

#[cfg(target_os = "macos")]
fn cg_send_key(keycode: u16, with_cmd: bool) {
    use std::ffi::c_void;
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreateKeyboardEvent(src: *const c_void, code: u16, down: bool) -> *mut c_void;
        fn CGEventSetFlags(ev: *mut c_void, flags: u64);
        fn CGEventPost(tap: u32, ev: *const c_void);
        fn CFRelease(cf: *const c_void);
    }
    const CMD: u64 = 1 << 20;
    let flags = if with_cmd { CMD } else { 0 };
    unsafe {
        let dn = CGEventCreateKeyboardEvent(std::ptr::null(), keycode, true);
        if !dn.is_null() { CGEventSetFlags(dn, flags); CGEventPost(0, dn); CFRelease(dn); }
        let up = CGEventCreateKeyboardEvent(std::ptr::null(), keycode, false);
        if !up.is_null() { CGEventSetFlags(up, flags); CGEventPost(0, up); CFRelease(up); }
    }
}

// ── macOS: native CGEventTap listener ─────────────────────────────────────────
//
// We previously used `rdev`, but its callback resolves a printable name for
// keyboard events via `TSMGetInputSourceProperty` — a main-thread-only API.
// Calling it from the tap's worker thread aborts the process with SIGTRAP
// the first time any key is pressed (including the Cmd+Shift+V global shortcut).
// Going direct lets us listen for exactly the events we care about and skip
// any TSM lookups.

#[cfg(target_os = "macos")]
mod mac_tap {
    use super::*;
    use std::ffi::c_void;
    use std::ptr;

    type CGEventTapProxy = *const c_void;
    type CGEventRef = *mut c_void;
    type CFMachPortRef = *mut c_void;
    type CFRunLoopSourceRef = *mut c_void;
    type CFRunLoopRef = *mut c_void;

    type TapCb = unsafe extern "C" fn(
        proxy: CGEventTapProxy,
        type_: u32,
        event: CGEventRef,
        user_info: *mut c_void,
    ) -> CGEventRef;

    const K_CG_SESSION_EVENT_TAP: u32 = 1;
    const K_CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
    const K_CG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;

    const K_CG_EVENT_LEFT_MOUSE_DOWN: u32 = 1;
    const K_CG_EVENT_LEFT_MOUSE_UP: u32 = 2;
    const K_CG_EVENT_LEFT_MOUSE_DRAGGED: u32 = 6;
    const K_CG_EVENT_KEY_DOWN: u32 = 10;
    const K_CG_EVENT_TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFFFFFE;
    const K_CG_EVENT_TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFFFFFF;

    const K_CG_KEYBOARD_EVENT_KEYCODE: u32 = 9;
    const FLAG_CMD: u64 = 1 << 20;
    const FLAG_SHIFT: u64 = 1 << 17;
    const FLAG_CTRL: u64 = 1 << 18;
    const FLAG_OPT: u64 = 1 << 19;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            events_of_interest: u64,
            callback: TapCb,
            user_info: *mut c_void,
        ) -> CFMachPortRef;
        fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
        fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
        fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
        fn CGEventGetFlags(event: CGEventRef) -> u64;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFMachPortCreateRunLoopSource(
            allocator: *const c_void,
            port: CFMachPortRef,
            order: isize,
        ) -> CFRunLoopSourceRef;
        fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: *const c_void);
        fn CFRunLoopGetCurrent() -> CFRunLoopRef;
        fn CFRunLoopRun();
        fn CFRelease(cf: *const c_void);
        static kCFRunLoopCommonModes: *const c_void;
    }

    struct Ctx {
        tx: mpsc::SyncSender<SelectionSignal>,
        tx_manual: mpsc::SyncSender<ManualCopySignal>,
        /// Low-level mouse stream consumed by the long-press detector in
        /// `paste.rs` (Down/Move/Up only fires while the button is down).
        tx_mouse: mpsc::SyncSender<MouseEvent>,
        /// Bumped on every observed Cmd+V (Ctrl+V on non-mac, handled in
        /// rdev_listener). The copy processor polls this between a drag-up
        /// and its synthetic Cmd+C, and bails if it advances — that's the
        /// signal the user is doing a select-to-replace, not a copy.
        paste_seq: Arc<AtomicU64>,
        press_x: f64,
        press_y: f64,
        button_down: bool,
        last_release: Instant,
        port: CFMachPortRef,
    }

    unsafe extern "C" fn callback(
        _proxy: CGEventTapProxy,
        ev_type: u32,
        ev: CGEventRef,
        user: *mut c_void,
    ) -> CGEventRef {
        let ctx = &mut *(user as *mut Ctx);

        // The tap can be disabled by the OS (slow callback or user input) — re-enable.
        if ev_type == K_CG_EVENT_TAP_DISABLED_BY_TIMEOUT
            || ev_type == K_CG_EVENT_TAP_DISABLED_BY_USER_INPUT
        {
            CGEventTapEnable(ctx.port, true);
            return ev;
        }

        match ev_type {
            K_CG_EVENT_LEFT_MOUSE_DOWN => {
                let p = CGEventGetLocation(ev);
                ctx.press_x = p.x;
                ctx.press_y = p.y;
                ctx.button_down = true;
                let _ = ctx.tx_mouse.try_send(MouseEvent::Down { x: p.x, y: p.y });
            }
            K_CG_EVENT_LEFT_MOUSE_DRAGGED => {
                if ctx.button_down {
                    let p = CGEventGetLocation(ev);
                    let _ = ctx.tx_mouse.try_send(MouseEvent::Move { x: p.x, y: p.y });
                }
            }
            K_CG_EVENT_LEFT_MOUSE_UP => {
                if ctx.button_down {
                    ctx.button_down = false;
                    let p = CGEventGetLocation(ev);
                    let _ = ctx.tx_mouse.try_send(MouseEvent::Up);
                    let dx = (p.x - ctx.press_x).abs();
                    let dy = (p.y - ctx.press_y).abs();
                    let gap = ctx.last_release.elapsed().as_millis();
                    let is_drag = dx > DRAG_PIXEL_THRESHOLD || dy > DRAG_PIXEL_THRESHOLD;
                    let is_multi = !is_drag
                        && gap > MULTI_CLICK_MIN_GAP_MS
                        && gap < MULTI_CLICK_MAX_GAP_MS;

                    ctx.last_release = if is_drag {
                        Instant::now() - Duration::from_secs(10)
                    } else {
                        Instant::now()
                    };

                    if is_drag || is_multi {
                        let _ = ctx.tx.try_send(SelectionSignal);
                    }
                }
            }
            K_CG_EVENT_KEY_DOWN => {
                let kc = CGEventGetIntegerValueField(ev, K_CG_KEYBOARD_EVENT_KEYCODE);
                let flags = CGEventGetFlags(ev) & (FLAG_CMD | FLAG_SHIFT | FLAG_CTRL | FLAG_OPT);
                // Cmd+A (no other modifiers) counts as "select all" → trigger capture.
                if kc == KEYCODE_A && flags == FLAG_CMD {
                    let _ = ctx.tx.try_send(SelectionSignal);
                }
                // Cmd+C (no other modifiers) is a manual copy gesture. lib.rs
                // distinguishes user-driven Cmd+C from our own simulate_copy()
                // synthetic events via a timestamp gate — this listener can't
                // tell them apart from the OS event stream alone.
                if kc as u16 == KEYCODE_C && flags == FLAG_CMD {
                    let _ = ctx.tx_manual.try_send(ManualCopySignal);
                }
                // Cmd+V — flags the in-flight selection (if any) as a
                // replace gesture so the copy processor doesn't clobber
                // the clipboard right before the user pastes into the
                // selection they just made. Cmd+Shift+V (panel toggle)
                // carries FLAG_SHIFT and is excluded by the exact match.
                if kc as u16 == KEYCODE_V && flags == FLAG_CMD {
                    ctx.paste_seq.fetch_add(1, Ordering::Relaxed);
                }
            }
            _ => {}
        }
        ev
    }

    pub fn run(
        tx: mpsc::SyncSender<SelectionSignal>,
        tx_manual: mpsc::SyncSender<ManualCopySignal>,
        tx_mouse: mpsc::SyncSender<MouseEvent>,
        paste_seq: Arc<AtomicU64>,
    ) {
        let mask: u64 = (1u64 << K_CG_EVENT_LEFT_MOUSE_DOWN)
            | (1u64 << K_CG_EVENT_LEFT_MOUSE_UP)
            | (1u64 << K_CG_EVENT_LEFT_MOUSE_DRAGGED)
            | (1u64 << K_CG_EVENT_KEY_DOWN);

        let ctx = Box::into_raw(Box::new(Ctx {
            tx,
            tx_manual,
            tx_mouse,
            paste_seq,
            press_x: 0.0,
            press_y: 0.0,
            button_down: false,
            last_release: Instant::now() - Duration::from_secs(10),
            port: ptr::null_mut(),
        }));

        unsafe {
            let port = CGEventTapCreate(
                K_CG_SESSION_EVENT_TAP,
                K_CG_HEAD_INSERT_EVENT_TAP,
                K_CG_EVENT_TAP_OPTION_LISTEN_ONLY,
                mask,
                callback,
                ctx as *mut c_void,
            );
            if port.is_null() {
                crate::elog!("[pluks] CGEventTapCreate failed — Input Monitoring permission missing?");
                drop(Box::from_raw(ctx));
                return;
            }
            (*ctx).port = port;

            let src = CFMachPortCreateRunLoopSource(ptr::null(), port, 0);
            CFRunLoopAddSource(CFRunLoopGetCurrent(), src, kCFRunLoopCommonModes);
            CGEventTapEnable(port, true);
            dlog!("[pluks] CGEventTap installed");
            CFRunLoopRun();

            // Unreachable in practice — CFRunLoopRun blocks for the thread's lifetime.
            CFRelease(src);
            CFRelease(port);
            drop(Box::from_raw(ctx));
        }
    }
}

// ── Windows & Linux: rdev-based input listener ────────────────────────────────
//
// Mirrors the macOS CGEventTap behavior: emits SelectionSignal on the same
// gestures (mouse drag, double/triple click, Ctrl+A). rdev surfaces global
// input events on Win32 (low-level keyboard/mouse hooks) and X11 (XRecord).
// On Wayland this returns Err immediately and the listener thread exits;
// the rest of the app keeps working as a manual clipboard manager.

#[cfg(not(target_os = "macos"))]
mod rdev_listener {
    use super::*;
    use rdev::{listen, Button, Event, EventType, Key};

    pub fn run(
        tx: mpsc::SyncSender<SelectionSignal>,
        tx_manual: mpsc::SyncSender<ManualCopySignal>,
        tx_mouse: mpsc::SyncSender<MouseEvent>,
        paste_seq: Arc<AtomicU64>,
    ) {
        let mut press_x = 0.0_f64;
        let mut press_y = 0.0_f64;
        let mut cur_x = 0.0_f64;
        let mut cur_y = 0.0_f64;
        let mut button_down = false;
        let mut last_release = Instant::now() - Duration::from_secs(10);
        // rdev doesn't surface modifier state on its events, so we track each
        // modifier ourselves by watching its KeyPress / KeyRelease.
        let mut ctrl = false;
        let mut shift = false;
        let mut alt = false;
        let mut meta = false;

        let cb = move |ev: Event| match ev.event_type {
            EventType::MouseMove { x, y } => {
                cur_x = x;
                cur_y = y;
                if button_down {
                    let _ = tx_mouse.try_send(MouseEvent::Move { x, y });
                }
            }
            EventType::ButtonPress(Button::Left) => {
                press_x = cur_x;
                press_y = cur_y;
                button_down = true;
                let _ = tx_mouse.try_send(MouseEvent::Down { x: cur_x, y: cur_y });
            }
            EventType::ButtonRelease(Button::Left) => {
                if !button_down { return; }
                button_down = false;
                let _ = tx_mouse.try_send(MouseEvent::Up);
                let dx = (cur_x - press_x).abs();
                let dy = (cur_y - press_y).abs();
                let gap = last_release.elapsed().as_millis();
                let is_drag = dx > DRAG_PIXEL_THRESHOLD || dy > DRAG_PIXEL_THRESHOLD;
                let is_multi = !is_drag
                    && gap > MULTI_CLICK_MIN_GAP_MS
                    && gap < MULTI_CLICK_MAX_GAP_MS;
                last_release = if is_drag {
                    Instant::now() - Duration::from_secs(10)
                } else {
                    Instant::now()
                };
                if is_drag || is_multi {
                    let _ = tx.try_send(SelectionSignal);
                }
            }
            EventType::KeyPress(k) => match k {
                Key::ControlLeft | Key::ControlRight => ctrl = true,
                Key::ShiftLeft | Key::ShiftRight => shift = true,
                Key::Alt | Key::AltGr => alt = true,
                Key::MetaLeft | Key::MetaRight => meta = true,
                Key::KeyA => {
                    if ctrl && !shift && !alt && !meta {
                        let _ = tx.try_send(SelectionSignal);
                    }
                }
                Key::KeyC => {
                    if ctrl && !shift && !alt && !meta {
                        let _ = tx_manual.try_send(ManualCopySignal);
                    }
                }
                Key::KeyV => {
                    // Mirrors the macOS Cmd+V detection. Ctrl+Shift+V
                    // (panel toggle) is excluded by the !shift guard.
                    if ctrl && !shift && !alt && !meta {
                        paste_seq.fetch_add(1, Ordering::Relaxed);
                    }
                }
                _ => {}
            },
            EventType::KeyRelease(k) => match k {
                Key::ControlLeft | Key::ControlRight => ctrl = false,
                Key::ShiftLeft | Key::ShiftRight => shift = false,
                Key::Alt | Key::AltGr => alt = false,
                Key::MetaLeft | Key::MetaRight => meta = false,
                _ => {}
            },
            _ => {}
        };

        if let Err(e) = listen(cb) {
            crate::elog!("[pluks] rdev listen failed (Wayland or missing X server?): {:?}", e);
        }
    }
}

pub fn start_listener(
    tx: mpsc::SyncSender<SelectionSignal>,
    tx_manual: mpsc::SyncSender<ManualCopySignal>,
    tx_mouse: mpsc::SyncSender<MouseEvent>,
    paste_seq: Arc<AtomicU64>,
) {
    thread::spawn(move || {
        // Surface the OS prompts up-front if either permission is missing.
        // The passive checks below (`ax_is_trusted` / `input_monitoring_granted`)
        // only *report* the state — they don't ask. Without an active request
        // here, a user who removes Pluks from System Settings → Input
        // Monitoring and relaunches would loop forever with no prompt and no
        // way back: the entry is gone from the list so the "Open Settings"
        // button lands on an empty panel. `IOHIDRequestAccess` and
        // `AXIsProcessTrustedWithOptions` both re-add the app to their
        // respective lists and trigger the standard macOS prompt.
        if !ax_is_trusted() {
            let _ = request_accessibility();
        }
        if !input_monitoring_granted() {
            let _ = request_input_monitoring();
        }
        loop {
            if ax_is_trusted() && input_monitoring_granted() { break; }
            dlog!("[pluks] Waiting for Accessibility / Input Monitoring permission...");
            thread::sleep(Duration::from_secs(2));
        }
        dlog!("[pluks] Permissions confirmed — starting listener.");

        #[cfg(target_os = "macos")]
        mac_tap::run(tx, tx_manual, tx_mouse, paste_seq);

        #[cfg(not(target_os = "macos"))]
        rdev_listener::run(tx, tx_manual, tx_mouse, paste_seq);
    });
}

// ── Keyboard simulation ───────────────────────────────────────────────────────

pub fn simulate_copy() {
    #[cfg(target_os = "macos")]
    cg_send_key(KEYCODE_C, true);

    #[cfg(not(target_os = "macos"))]
    {
        use enigo::{Direction, Enigo, Key, Keyboard, Settings};
        if let Ok(mut e) = Enigo::new(&Settings::default()) {
            let _ = e.key(Key::Control, Direction::Press);
            let _ = e.key(Key::Unicode('c'), Direction::Click);
            let _ = e.key(Key::Control, Direction::Release);
        }
    }
}

pub fn simulate_paste() {
    #[cfg(target_os = "macos")]
    cg_send_key(KEYCODE_V, true);

    #[cfg(not(target_os = "macos"))]
    {
        use enigo::{Direction, Enigo, Key, Keyboard, Settings};
        if let Ok(mut e) = Enigo::new(&Settings::default()) {
            let _ = e.key(Key::Control, Direction::Press);
            let _ = e.key(Key::Unicode('v'), Direction::Click);
            let _ = e.key(Key::Control, Direction::Release);
        }
    }
}

// ── Clipboard ─────────────────────────────────────────────────────────────────

pub use arboard::Clipboard;

pub fn read_clipboard(clip: &mut Option<Clipboard>) -> Option<String> {
    if clip.is_none() {
        *clip = Clipboard::new().ok();
    }
    clip.as_mut()?
        .get_text()
        .ok()
        .map(|s| s.trim_end_matches(['\r', '\n', ' ', '\t']).to_string())
        .filter(|s| !s.trim().is_empty())
}

pub fn write_clipboard(text: &str) -> bool {
    Clipboard::new()
        .ok()
        .and_then(|mut c| c.set_text(text).ok())
        .is_some()
}

// ── Clipboard change detection & concealed-content filtering ────────────────────
//
// The clipboard poller (`start_clipboard_poller` in lib.rs) records *any*
// clipboard change into history — manual Cmd+C / Ctrl+C, right-click → Copy,
// "Copy" buttons, copies from other apps — not just the select-to-copy gesture
// the rest of this module drives. Two platform primitives gate it:
//
//   * `clipboard_change_token` — a cheap, monotonically-changing token (macOS
//     `NSPasteboard.changeCount`, Windows `GetClipboardSequenceNumber`). The
//     poller only performs the expensive type-inspection + text read when this
//     advances. X11/Wayland expose no comparable counter through arboard, so
//     Linux returns `None` and the poller falls back to content comparison.
//
//   * `clipboard_is_concealed` — true when the current clipboard owner asked
//     clipboard managers NOT to persist the content. This is the mechanism
//     password managers use to keep copied secrets out of clipboard history.
//     We honor the de-facto cross-platform conventions:
//       - macOS:   `org.nspasteboard.ConcealedType` / `org.nspasteboard.TransientType`
//       - Windows: `ExcludeClipboardContentFromMonitorProcessing` (presence) and
//                  `CanIncludeInClipboardHistory` (a DWORD whose value is 0)
//     When this returns true the poller never even reads the text — a copied
//     password never enters a Rust `String`, the database, or the live panel.

#[cfg(target_os = "macos")]
pub fn clipboard_change_token() -> Option<u64> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    unsafe {
        extern "C" {
            fn objc_getClass(name: *const u8) -> *mut AnyObject;
        }
        let cls = objc_getClass(b"NSPasteboard\0".as_ptr());
        if cls.is_null() {
            return None;
        }
        let pb: *mut AnyObject = msg_send![cls, generalPasteboard];
        if pb.is_null() {
            return None;
        }
        let count: i64 = msg_send![pb, changeCount];
        Some(count as u64)
    }
}

#[cfg(target_os = "macos")]
pub fn clipboard_is_concealed() -> bool {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use std::os::raw::c_char;
    use std::ptr;
    unsafe {
        extern "C" {
            fn objc_getClass(name: *const u8) -> *mut AnyObject;
        }
        // The poller calls this every time the clipboard changes. `-types`
        // returns an autoreleased NSArray of autoreleased NSStrings; without a
        // pool around them they'd leak on this long-lived worker thread.
        let pool_cls = objc_getClass(b"NSAutoreleasePool\0".as_ptr());
        let pool: *mut AnyObject = if pool_cls.is_null() {
            ptr::null_mut()
        } else {
            let p: *mut AnyObject = msg_send![pool_cls, alloc];
            msg_send![p, init]
        };

        let mut concealed = false;
        let cls = objc_getClass(b"NSPasteboard\0".as_ptr());
        if !cls.is_null() {
            let pb: *mut AnyObject = msg_send![cls, generalPasteboard];
            if !pb.is_null() {
                let types: *mut AnyObject = msg_send![pb, types];
                if !types.is_null() {
                    let count: usize = msg_send![types, count];
                    for i in 0..count {
                        let t: *mut AnyObject = msg_send![types, objectAtIndex: i];
                        if t.is_null() {
                            continue;
                        }
                        let utf8: *const c_char = msg_send![t, UTF8String];
                        if utf8.is_null() {
                            continue;
                        }
                        if let Ok(s) = std::ffi::CStr::from_ptr(utf8).to_str() {
                            if s == "org.nspasteboard.ConcealedType"
                                || s == "org.nspasteboard.TransientType"
                            {
                                concealed = true;
                                break;
                            }
                        }
                    }
                }
            }
        }

        if !pool.is_null() {
            let _: () = msg_send![pool, drain];
        }
        concealed
    }
}

#[cfg(target_os = "windows")]
pub fn clipboard_change_token() -> Option<u64> {
    extern "system" {
        fn GetClipboardSequenceNumber() -> u32;
    }
    unsafe { Some(GetClipboardSequenceNumber() as u64) }
}

#[cfg(target_os = "windows")]
pub fn clipboard_is_concealed() -> bool {
    use std::ffi::c_void;
    extern "system" {
        fn RegisterClipboardFormatA(lpsz: *const u8) -> u32;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
        fn OpenClipboard(hwnd: *mut c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn GetClipboardData(format: u32) -> *mut c_void;
        fn GlobalLock(h: *mut c_void) -> *mut c_void;
        fn GlobalUnlock(h: *mut c_void) -> i32;
    }
    unsafe {
        // Unambiguous: the mere presence of this format means "exclude from all
        // clipboard monitoring / history" (set by KeePass and similar). No
        // value to read.
        let exclude =
            RegisterClipboardFormatA(b"ExcludeClipboardContentFromMonitorProcessing\0".as_ptr());
        if exclude != 0 && IsClipboardFormatAvailable(exclude) != 0 {
            return true;
        }
        // `CanIncludeInClipboardHistory` is a DWORD: value 0 means "do not keep
        // in history", value 1 means "allowed". Presence alone is NOT exclusion,
        // so we must read the value. Reading needs the clipboard open; the
        // poller calls this BEFORE its arboard read, so there's no contention.
        let hist = RegisterClipboardFormatA(b"CanIncludeInClipboardHistory\0".as_ptr());
        if hist != 0 && IsClipboardFormatAvailable(hist) != 0 {
            // Another process may briefly own the clipboard — retry a few
            // times. If we ultimately can't read the value, fail safe to
            // "concealed": dropping one clip is better than persisting a secret
            // its owner explicitly flagged.
            let null_hwnd: *mut c_void = std::ptr::null_mut();
            for _ in 0..5 {
                if OpenClipboard(null_hwnd) != 0 {
                    let mut excluded = true;
                    let h = GetClipboardData(hist);
                    if !h.is_null() {
                        let p = GlobalLock(h);
                        if !p.is_null() {
                            excluded = *(p as *const u32) == 0;
                            GlobalUnlock(h);
                        }
                    }
                    CloseClipboard();
                    return excluded;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            return true;
        }
        false
    }
}

#[cfg(target_os = "linux")]
pub fn clipboard_change_token() -> Option<u64> {
    // X11 exposes no cheap clipboard sequence number through arboard, and
    // Wayland clipboard semantics vary by compositor. The poller falls back to
    // comparing the current clipboard text against the last value it recorded.
    None
}

#[cfg(target_os = "linux")]
pub fn clipboard_is_concealed() -> bool {
    // KNOWN LIMITATION: no concealed-content filtering on Linux yet. The
    // klipper/KDE convention is the `x-kde-passwordManagerHint=secret` X11
    // selection target; honoring it means inspecting selection targets below
    // arboard (raw X11 / Wayland data-control), which we don't do here. Mirrors
    // `focus_is_secure_field`, which is likewise macOS-only today. Tracked for a
    // follow-up; until then Linux users with KDE password managers won't get the
    // concealed-type skip.
    false
}

#[cfg(test)]
mod clipboard_primitive_tests {
    // Per-OS coverage: Linux pins the documented fallback contract the poller
    // relies on (no change token → content comparison; no concealed filtering
    // yet). Windows executes the real Win32 FFI on the `app-rust-windows` CI
    // job — the only place it can run. The macOS NSPasteboard variants remain
    // compile-checked by the build-smoke matrix and covered by the manual
    // release regression plan (tests/RELEASE_REGRESSION_TESTS.md).
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_has_no_change_token() {
        assert!(
            super::clipboard_change_token().is_none(),
            "Linux must report no clipboard sequence number so the poller \
             falls back to content comparison"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_reports_not_concealed() {
        assert!(
            !super::clipboard_is_concealed(),
            "Linux concealed detection is a documented no-op for now"
        );
    }

    // ── Windows: execute the real clipboard primitives ──────────────────────
    //
    // The clipboard is process-global mutable state and `cargo test` runs
    // tests on parallel threads, so every test below serializes on CLIP_LOCK
    // (recovering from poisoning — one failed test must not cascade). The raw
    // writer mirrors the production code's FFI conventions (`extern "system"`
    // declarations, no windows-sys dependency) and is what lets us plant the
    // concealment formats password managers set.
    #[cfg(target_os = "windows")]
    mod windows {
        use crate::selection::{
            clipboard_change_token, clipboard_is_concealed, read_clipboard, write_clipboard,
        };
        use std::ffi::c_void;
        use std::sync::{Mutex, MutexGuard};
        use std::time::Duration;

        static CLIP_LOCK: Mutex<()> = Mutex::new(());

        fn lock() -> MutexGuard<'static, ()> {
            CLIP_LOCK.lock().unwrap_or_else(|e| e.into_inner())
        }

        fn unique_marker(prefix: &str) -> String {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            format!("{prefix}-{nanos}")
        }

        #[link(name = "user32")]
        extern "system" {
            fn OpenClipboard(hwnd: *mut c_void) -> i32;
            fn CloseClipboard() -> i32;
            fn EmptyClipboard() -> i32;
            fn SetClipboardData(format: u32, h: *mut c_void) -> *mut c_void;
            fn RegisterClipboardFormatA(name: *const u8) -> u32;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GlobalAlloc(flags: u32, bytes: usize) -> *mut c_void;
            fn GlobalLock(h: *mut c_void) -> *mut c_void;
            fn GlobalUnlock(h: *mut c_void) -> i32;
            fn GlobalFree(h: *mut c_void) -> *mut c_void;
        }

        const CF_UNICODETEXT: u32 = 13;
        const GMEM_MOVEABLE: u32 = 0x0002;

        unsafe fn global_from_bytes(bytes: &[u8]) -> *mut c_void {
            let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
            assert!(!h.is_null(), "GlobalAlloc failed");
            let p = GlobalLock(h);
            assert!(!p.is_null(), "GlobalLock failed");
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), p as *mut u8, bytes.len());
            GlobalUnlock(h);
            h
        }

        /// Set clipboard text plus an optional extra registered format: a
        /// DWORD payload (`Some(value)`) for value-carrying formats like
        /// `CanIncludeInClipboardHistory`, or a 4-byte placeholder (`None`)
        /// for presence-only markers. `name` must be NUL-terminated.
        fn set_clipboard_with_format(text: &str, extra: Option<(&[u8], Option<u32>)>) {
            unsafe {
                // Another process may briefly hold the clipboard — retry,
                // like production's `clipboard_is_concealed` does.
                let mut opened = false;
                for _ in 0..50 {
                    if OpenClipboard(std::ptr::null_mut()) != 0 {
                        opened = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                assert!(opened, "OpenClipboard failed after retries");
                EmptyClipboard();

                let utf16: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
                let bytes =
                    std::slice::from_raw_parts(utf16.as_ptr() as *const u8, utf16.len() * 2);
                let htext = global_from_bytes(bytes);
                // On success the system owns the handle; free it only on failure.
                if SetClipboardData(CF_UNICODETEXT, htext).is_null() {
                    GlobalFree(htext);
                    CloseClipboard();
                    panic!("SetClipboardData(CF_UNICODETEXT) failed");
                }

                if let Some((name, dword)) = extra {
                    let fmt = RegisterClipboardFormatA(name.as_ptr());
                    assert_ne!(fmt, 0, "RegisterClipboardFormatA failed");
                    let payload: Vec<u8> = match dword {
                        Some(v) => v.to_le_bytes().to_vec(),
                        None => vec![0u8; 4],
                    };
                    let hextra = global_from_bytes(&payload);
                    if SetClipboardData(fmt, hextra).is_null() {
                        GlobalFree(hextra);
                        CloseClipboard();
                        panic!("SetClipboardData(extra format) failed");
                    }
                }
                CloseClipboard();
            }
        }

        #[test]
        fn change_token_advances_after_write() {
            let _g = lock();
            let t1 = clipboard_change_token().expect("Windows must expose a sequence number");
            assert!(
                write_clipboard(&unique_marker("pluks-token-test")),
                "arboard clipboard write failed"
            );
            // The sequence number updates synchronously with the write, but
            // give a busy runner a moment before declaring failure.
            let mut t2 = clipboard_change_token().unwrap();
            for _ in 0..40 {
                if t2 != t1 {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
                t2 = clipboard_change_token().unwrap();
            }
            assert_ne!(
                t1, t2,
                "GetClipboardSequenceNumber must advance after a clipboard write"
            );
        }

        #[test]
        fn clipboard_roundtrips_through_arboard() {
            let _g = lock();
            // No trailing whitespace: read_clipboard trims it.
            let marker = unique_marker("pluks-roundtrip");
            assert!(write_clipboard(&marker), "arboard clipboard write failed");
            let mut clip = None;
            let mut got = read_clipboard(&mut clip);
            for _ in 0..40 {
                if got.as_deref() == Some(marker.as_str()) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
                got = read_clipboard(&mut clip);
            }
            assert_eq!(got.as_deref(), Some(marker.as_str()));
        }

        #[test]
        fn plain_text_is_not_concealed() {
            let _g = lock();
            set_clipboard_with_format("pluks-plain-text", None);
            assert!(
                !clipboard_is_concealed(),
                "plain text must not be treated as concealed"
            );
        }

        #[test]
        fn exclude_format_presence_is_concealed() {
            let _g = lock();
            set_clipboard_with_format(
                "pluks-secret",
                Some((b"ExcludeClipboardContentFromMonitorProcessing\0", None)),
            );
            assert!(
                clipboard_is_concealed(),
                "presence of the KeePass-convention exclude format must conceal"
            );
        }

        #[test]
        fn history_dword_zero_is_concealed() {
            let _g = lock();
            set_clipboard_with_format(
                "pluks-secret",
                Some((b"CanIncludeInClipboardHistory\0", Some(0))),
            );
            assert!(
                clipboard_is_concealed(),
                "CanIncludeInClipboardHistory=0 must conceal"
            );
        }

        #[test]
        fn history_dword_one_is_allowed() {
            let _g = lock();
            set_clipboard_with_format(
                "pluks-allowed",
                Some((b"CanIncludeInClipboardHistory\0", Some(1))),
            );
            assert!(
                !clipboard_is_concealed(),
                "CanIncludeInClipboardHistory=1 explicitly allows history capture"
            );
        }
    }
}

// Windows desktop-state primitives. Both can legitimately report "nothing" in
// a non-interactive window station (no foreground window, no cursor), so these
// pin the production fallback contract rather than demanding an interactive
// desktop — the windows-smoke workflow covers interactive behavior with the
// real app.
#[cfg(all(test, target_os = "windows"))]
mod win32_desktop_primitive_tests {
    #[test]
    fn cursor_pos_executes_with_finite_coordinates() {
        // Contract: real coordinates (negative is legal on multi-monitor
        // setups) or the documented (0.0, 0.0) fallback — never a panic.
        let (x, y) = super::cursor_pos();
        assert!(x.is_finite() && y.is_finite());
    }

    #[test]
    fn frontmost_pid_is_positive_when_present() {
        // GetForegroundWindow may legitimately be null on a desktop with no
        // foreground window; only the Some case carries a guarantee.
        if let Some(pid) = super::frontmost_pid() {
            assert!(pid > 0, "a reported foreground PID must be positive");
        }
    }
}
