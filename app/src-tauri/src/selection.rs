use rdev::{listen, Button, Event, EventType};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Sent from the rdev listener to the processing thread when a text selection is likely.
pub struct SelectionSignal;

/// Starts the global mouse-event listener in a background thread.
/// Sends a `SelectionSignal` over `tx` whenever a drag-selection or
/// multi-click (double/triple) is detected.
///
/// Platform notes:
///   - macOS: Requires "Input Monitoring" permission (System Settings → Privacy).
///   - Windows: Works out of the box.
///   - Linux (X11/Wayland): May require running as the user who owns the display.
pub fn start_listener(tx: mpsc::Sender<SelectionSignal>) {
    thread::spawn(move || {
        let mut cur_x = 0.0f64;
        let mut cur_y = 0.0f64;
        let mut press_x = 0.0f64;
        let mut press_y = 0.0f64;
        let mut last_press = Instant::now();
        let mut click_count: u32 = 0;
        // Track if mouse button is currently down
        let mut button_down = false;

        if let Err(e) = listen(move |event: Event| {
            match event.event_type {
                EventType::MouseMove { x, y } => {
                    cur_x = x;
                    cur_y = y;
                }
                EventType::ButtonPress(Button::Left) => {
                    let now = Instant::now();
                    // Rapid successive clicks → multi-click selection
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
            eprintln!("[Pluck] rdev listener error: {:?}", e);
            eprintln!("[Pluck] On macOS, grant Input Monitoring permission in System Settings → Privacy & Security.");
        }
    });
}

/// Simulates Ctrl+C (or Cmd+C on macOS) to copy the current selection.
/// Requires Accessibility permission on macOS.
pub fn simulate_copy() {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};

    let settings = Settings::default();
    let Ok(mut enigo) = Enigo::new(&settings) else {
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

/// Reads the current clipboard text. Returns `None` if empty or on error.
pub fn read_clipboard() -> Option<String> {
    use arboard::Clipboard;
    Clipboard::new().ok()?.get_text().ok().filter(|s| !s.trim().is_empty())
}
