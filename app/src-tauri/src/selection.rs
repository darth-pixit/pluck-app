use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

pub struct SelectionSignal;

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
        eprintln!($($arg)*);
    };
}

// ── macOS: permission checks ───────────────────────────────────────────────────

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
    unsafe { IOHIDCheckAccess(1) == 0 }
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
fn cursor_pos() -> (f64, f64) {
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
            }
            K_CG_EVENT_LEFT_MOUSE_UP => {
                if ctx.button_down {
                    ctx.button_down = false;
                    let p = CGEventGetLocation(ev);
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
                // Only Cmd+A (no other modifiers) counts as "select all".
                let kc = CGEventGetIntegerValueField(ev, K_CG_KEYBOARD_EVENT_KEYCODE);
                let flags = CGEventGetFlags(ev) & (FLAG_CMD | FLAG_SHIFT | FLAG_CTRL | FLAG_OPT);
                if kc == KEYCODE_A && flags == FLAG_CMD {
                    let _ = ctx.tx.try_send(SelectionSignal);
                }
            }
            _ => {}
        }
        ev
    }

    pub fn run(tx: mpsc::SyncSender<SelectionSignal>) {
        let mask: u64 = (1u64 << K_CG_EVENT_LEFT_MOUSE_DOWN)
            | (1u64 << K_CG_EVENT_LEFT_MOUSE_UP)
            | (1u64 << K_CG_EVENT_KEY_DOWN);

        let ctx = Box::into_raw(Box::new(Ctx {
            tx,
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
                eprintln!("[pluks] CGEventTapCreate failed — Input Monitoring permission missing?");
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

    pub fn run(tx: mpsc::SyncSender<SelectionSignal>) {
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
            EventType::MouseMove { x, y } => { cur_x = x; cur_y = y; }
            EventType::ButtonPress(Button::Left) => {
                press_x = cur_x;
                press_y = cur_y;
                button_down = true;
            }
            EventType::ButtonRelease(Button::Left) => {
                if !button_down { return; }
                button_down = false;
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
            eprintln!("[pluks] rdev listen failed (Wayland or missing X server?): {:?}", e);
        }
    }
}

pub fn start_listener(tx: mpsc::SyncSender<SelectionSignal>) {
    thread::spawn(move || {
        loop {
            if ax_is_trusted() && input_monitoring_granted() { break; }
            dlog!("[pluks] Waiting for Accessibility / Input Monitoring permission...");
            thread::sleep(Duration::from_secs(2));
        }
        dlog!("[pluks] Permissions confirmed — starting listener.");

        #[cfg(target_os = "macos")]
        mac_tap::run(tx);

        #[cfg(not(target_os = "macos"))]
        rdev_listener::run(tx);
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
