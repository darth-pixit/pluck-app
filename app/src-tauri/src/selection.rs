use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Sent to the processing thread when a text selection is likely.
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
    // IOHIDCheckAccess(kIOHIDRequestTypeListenForNewDevices=1)
    // returns kIOHIDAccessTypeGranted=0 when permission is granted.
    #[link(name = "IOKit", kind = "framework")]
    extern "C" { fn IOHIDCheckAccess(request_type: u32) -> i32; }
    unsafe { IOHIDCheckAccess(1) == 0 }
}

/// Starts the global mouse-event listener in a background thread.
/// On macOS, waits until Accessibility permission is granted before
/// creating the CGEventTap (and retries automatically if it fails).
pub fn start_listener(tx: mpsc::Sender<SelectionSignal>) {
    thread::spawn(move || {
        // ── macOS: poll until both permissions are granted ────────────────
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

        // ── Retry loop — recreate CGEventTap if rdev fails ────────────────
        loop {
            let tx = tx.clone();

            // Position tracking — rdev maps kCGEventLeftMouseDragged → MouseMove,
            // so cur_x/cur_y update correctly during a drag.
            let mut cur_x: f64 = 0.0;
            let mut cur_y: f64 = 0.0;
            let mut press_x: f64 = 0.0;
            let mut press_y: f64 = 0.0;
            let mut button_down = false;

            // For double/triple-click detection
            let mut last_release = Instant::now() - Duration::from_secs(10);

            eprintln!("[pluks] rdev listener starting...");

            use rdev::{listen, Button, Event, EventType};

            let result = listen(move |event: Event| {
                match event.event_type {
                    // MouseMove fires for both hover AND drag (kCGEventLeftMouseDragged)
                    EventType::MouseMove { x, y } => {
                        cur_x = x;
                        cur_y = y;
                    }
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
                        let since_last_release = last_release.elapsed().as_millis();
                        last_release = Instant::now();

                        // Drag: cursor moved more than 4 px while button was held
                        let is_drag = dx > 4.0 || dy > 4.0;
                        // Multi-click (double/triple): two quick releases within 600 ms
                        // Gap > 30 ms guards against duplicate events from one click
                        let is_multi_click = !is_drag
                            && since_last_release < 600
                            && since_last_release > 30;

                        eprintln!(
                            "[pluks] MouseUp dx={:.1} dy={:.1} gap={}ms drag={} multi={}",
                            dx, dy, since_last_release, is_drag, is_multi_click
                        );

                        if is_drag || is_multi_click {
                            eprintln!("[pluks] SelectionSignal sent!");
                            let _ = tx.send(SelectionSignal);
                        }
                    }
                    _ => {}
                }
            });

            match result {
                Ok(_) => {
                    eprintln!("[pluks] rdev listener exited (unexpected), retrying in 2s...");
                }
                Err(e) => {
                    eprintln!("[pluks] rdev listener error: {:?}, retrying in 3s...", e);
                    thread::sleep(Duration::from_secs(3));
                }
            }

            thread::sleep(Duration::from_secs(1));
        }
    });
}

// ── Shared: simulate copy + read clipboard ────────────────────────────────────

/// Simulates Cmd+C (macOS) or Ctrl+C (Windows/Linux).
/// Requires Accessibility permission on macOS.
pub fn simulate_copy() {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};

    let settings = Settings::default();
    let Ok(mut enigo) = Enigo::new(&settings) else {
        eprintln!("[pluks] enigo init failed — Accessibility permission missing?");
        return;
    };

    #[cfg(target_os = "macos")]
    {
        let _ = enigo.key(Key::Meta, Direction::Press);
        let _ = enigo.key(Key::Unicode('c'), Direction::Click);
        let _ = enigo.key(Key::Meta, Direction::Release);
        eprintln!("[pluks] Cmd+C sent");
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = enigo.key(Key::Control, Direction::Press);
        let _ = enigo.key(Key::Unicode('c'), Direction::Click);
        let _ = enigo.key(Key::Control, Direction::Release);
        eprintln!("[pluks] Ctrl+C sent");
    }
}

/// Reads current clipboard text. Returns None if empty or on error.
pub fn read_clipboard() -> Option<String> {
    use arboard::Clipboard;
    Clipboard::new()
        .ok()?
        .get_text()
        .ok()
        .filter(|s: &String| !s.trim().is_empty())
}
