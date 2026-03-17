use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

pub struct SelectionSignal;

// ── macOS: permission checks ───────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn ax_is_trusted() -> bool {
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" { fn AXIsProcessTrusted() -> bool; }
    unsafe { AXIsProcessTrusted() }
}

#[cfg(target_os = "macos")]
fn input_monitoring_granted() -> bool {
    #[link(name = "IOKit", kind = "framework")]
    extern "C" { fn IOHIDCheckAccess(request_type: u32) -> i32; }
    unsafe { IOHIDCheckAccess(1) == 0 }
}

// ── macOS: real cursor position via CGEvent ────────────────────────────────────

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint { x: f64, y: f64 }

#[cfg(target_os = "macos")]
fn cursor_pos() -> (f64, f64) {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
        fn CGEventGetLocation(event: *const std::ffi::c_void) -> CGPoint;
        fn CFRelease(cf: *const std::ffi::c_void);
    }
    unsafe {
        let ev = CGEventCreate(std::ptr::null());
        if ev.is_null() { return (0.0, 0.0); }
        let pt = CGEventGetLocation(ev);
        CFRelease(ev);
        (pt.x, pt.y)
    }
}

#[cfg(not(target_os = "macos"))]
fn cursor_pos() -> (f64, f64) { (0.0, 0.0) }

// ── macOS: keyboard simulation via CGEvent (bypasses enigo) ───────────────────

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
    const CMD: u64 = 1 << 20; // kCGEventFlagMaskCommand
    let flags = if with_cmd { CMD } else { 0 };
    unsafe {
        let dn = CGEventCreateKeyboardEvent(std::ptr::null(), keycode, true);
        if !dn.is_null() { CGEventSetFlags(dn, flags); CGEventPost(0, dn); CFRelease(dn); }
        let up = CGEventCreateKeyboardEvent(std::ptr::null(), keycode, false);
        if !up.is_null() { CGEventSetFlags(up, flags); CGEventPost(0, up); CFRelease(up); }
    }
}

// ── Listener ──────────────────────────────────────────────────────────────────

pub fn start_listener(tx: mpsc::Sender<SelectionSignal>) {
    thread::spawn(move || {
        #[cfg(target_os = "macos")]
        {
            loop {
                let ax = ax_is_trusted();
                let im = input_monitoring_granted();
                if ax && im { break; }
                if !ax { eprintln!("[pluks] Waiting for Accessibility permission..."); }
                if !im { eprintln!("[pluks] Waiting for Input Monitoring permission..."); }
                thread::sleep(Duration::from_secs(2));
            }
            eprintln!("[pluks] Both permissions confirmed — starting listener.");
        }

        loop {
            let tx = tx.clone();
            let mut press_x: f64 = 0.0;
            let mut press_y: f64 = 0.0;
            let mut button_down = false;
            let mut last_release = Instant::now() - Duration::from_secs(10);

            eprintln!("[pluks] rdev listener starting...");
            use rdev::{listen, Button, Event, EventType};

            let result = listen(move |event: Event| {
                match event.event_type {
                    EventType::ButtonPress(Button::Left) => {
                        let (x, y) = cursor_pos();
                        press_x = x; press_y = y; button_down = true;
                    }
                    EventType::ButtonRelease(Button::Left) => {
                        if !button_down { return; }
                        button_down = false;
                        let (cx, cy) = cursor_pos();
                        let dx = (cx - press_x).abs();
                        let dy = (cy - press_y).abs();
                        let gap = last_release.elapsed().as_millis();
                        last_release = Instant::now();
                        let is_drag = dx > 4.0 || dy > 4.0;
                        let is_multi = !is_drag && gap < 600 && gap > 30;
                        eprintln!("[pluks] MouseUp dx={:.1} dy={:.1} gap={}ms drag={} multi={}", dx, dy, gap, is_drag, is_multi);
                        if is_drag || is_multi {
                            eprintln!("[pluks] SelectionSignal sent!");
                            let _ = tx.send(SelectionSignal);
                        }
                    }
                    _ => {}
                }
            });

            match result {
                Ok(_) => { eprintln!("[pluks] rdev exited unexpectedly, retrying in 2s..."); }
                Err(e) => { eprintln!("[pluks] rdev error: {:?}, retrying in 3s...", e); thread::sleep(Duration::from_secs(3)); }
            }
            thread::sleep(Duration::from_secs(1));
        }
    });
}

// ── Keyboard simulation ───────────────────────────────────────────────────────

/// Cmd+C (macOS via CGEventPost; Ctrl+C elsewhere via enigo).
pub fn simulate_copy() {
    #[cfg(target_os = "macos")]
    { cg_send_key(8, true); eprintln!("[pluks] Cmd+C via CGEvent"); } // keycode 8 = 'c'

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

/// Cmd+V (macOS via CGEventPost; Ctrl+V elsewhere via enigo).
/// Call this after hiding the panel so focus has returned to the previous app.
pub fn simulate_paste() {
    #[cfg(target_os = "macos")]
    { cg_send_key(9, true); eprintln!("[pluks] Cmd+V via CGEvent"); } // keycode 9 = 'v'

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

pub fn read_clipboard() -> Option<String> {
    use arboard::Clipboard;
    Clipboard::new().ok()?.get_text().ok().filter(|s| !s.trim().is_empty())
}
