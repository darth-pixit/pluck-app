use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Sent to the processing thread when a text selection is likely.
pub struct SelectionSignal;

/// Starts the global mouse-event listener in a background thread.
/// macOS: uses CGEventSourceButtonState polling — no Input Monitoring needed.
/// Windows/Linux: uses rdev CGEventTap.
pub fn start_listener(tx: mpsc::Sender<SelectionSignal>) {
    #[cfg(target_os = "macos")]
    start_listener_macos(tx);

    #[cfg(not(target_os = "macos"))]
    start_listener_rdev(tx);
}

// ── macOS: polling via CoreGraphics (no special permissions needed) ───────────

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    // Returns true if the given mouse button is currently down.
    // stateID 0 = kCGEventSourceStateCombinedSessionState
    // button  0 = kCGMouseButtonLeft
    fn CGEventSourceButtonState(stateID: i32, button: u32) -> bool;
}

#[cfg(target_os = "macos")]
fn start_listener_macos(tx: mpsc::Sender<SelectionSignal>) {
    thread::spawn(move || {
        eprintln!("[pluks] macOS polling listener starting...");

        let mut was_down = false;
        let mut press_x = 0.0f64;
        let mut press_y = 0.0f64;
        let mut last_release = Instant::now();
        let mut click_count: u32 = 0;

        loop {
            let is_down = unsafe { CGEventSourceButtonState(0, 0) };
            let loc = unsafe { objc2_app_kit::NSEvent::mouseLocation() };
            let cur_x = loc.x;
            let cur_y = loc.y;

            if is_down && !was_down {
                eprintln!("[pluks] MouseDown at ({:.0},{:.0})", cur_x, cur_y);
                let now = Instant::now();
                if now.duration_since(last_release) < Duration::from_millis(500) {
                    click_count += 1;
                } else {
                    click_count = 1;
                }
                press_x = cur_x;
                press_y = cur_y;
            } else if !is_down && was_down {
                let dx = (cur_x - press_x).abs();
                let dy = (cur_y - press_y).abs();
                let is_drag = dx > 4.0 || dy > 4.0;
                let is_multi_click = click_count >= 2;
                last_release = Instant::now();

                eprintln!(
                    "[pluks] MouseUp dx={:.1} dy={:.1} drag={} multi={} clicks={}",
                    dx, dy, is_drag, is_multi_click, click_count
                );

                if is_drag || is_multi_click {
                    eprintln!("[pluks] SelectionSignal sent!");
                    let _ = tx.send(SelectionSignal);
                    if is_multi_click {
                        click_count = 0;
                    }
                }
            }

            was_down = is_down;
            thread::sleep(Duration::from_millis(16)); // ~60fps polling
        }
    });
}

// ── Windows / Linux: rdev ─────────────────────────────────────────────────────

#[cfg(not(target_os = "macos"))]
fn start_listener_rdev(tx: mpsc::Sender<SelectionSignal>) {
    use rdev::{listen, Button, Event, EventType};

    thread::spawn(move || {
        let mut cur_x = 0.0f64;
        let mut cur_y = 0.0f64;
        let mut press_x = 0.0f64;
        let mut press_y = 0.0f64;
        let mut last_press = Instant::now();
        let mut click_count: u32 = 0;
        let mut button_down = false;

        if let Err(e) = listen(move |event: Event| {
            match event.event_type {
                EventType::MouseMove { x, y } => {
                    cur_x = x;
                    cur_y = y;
                }
                EventType::ButtonPress(Button::Left) => {
                    let now = Instant::now();
                    if now.duration_since(last_press) < Duration::from_millis(500) {
                        click_count += 1;
                    } else {
                        click_count = 1;
                    }
                    last_press = now;
                    press_x = cur_x;
                    press_y = cur_y;
                    button_down = true;
                }
                EventType::ButtonRelease(Button::Left) => {
                    if !button_down {
                        return;
                    }
                    button_down = false;
                    let dx = (cur_x - press_x).abs();
                    let dy = (cur_y - press_y).abs();
                    let is_drag = dx > 4.0 || dy > 4.0;
                    let is_multi_click = click_count >= 2;
                    if is_drag || is_multi_click {
                        let _ = tx.send(SelectionSignal);
                        if is_multi_click {
                            click_count = 0;
                        }
                    }
                }
                _ => {}
            }
        }) {
            eprintln!("[pluks] rdev listener error: {:?}", e);
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
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = enigo.key(Key::Control, Direction::Press);
        let _ = enigo.key(Key::Unicode('c'), Direction::Click);
        let _ = enigo.key(Key::Control, Direction::Release);
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
