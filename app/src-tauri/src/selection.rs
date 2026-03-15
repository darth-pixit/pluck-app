use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Sent to the processing thread when a text selection is likely.
pub struct SelectionSignal;

// ── macOS: check Accessibility permission ─────────────────────────────────────

#[cfg(target_os = "macos")]
fn ax_is_trusted() -> bool {
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }
    unsafe { AXIsProcessTrusted() }
}

/// Starts the global mouse-event listener in a background thread.
/// On macOS, waits until Accessibility permission is granted before
/// creating the CGEventTap (and retries automatically if it fails).
pub fn start_listener(tx: mpsc::Sender<SelectionSignal>) {
    thread::spawn(move || {
        // ── macOS: poll until Accessibility is granted ────────────────────
        #[cfg(target_os = "macos")]
        {
            while !ax_is_trusted() {
                eprintln!("[pluks] Waiting for Accessibility permission...");
                thread::sleep(Duration::from_secs(2));
            }
            eprintln!("[pluks] Accessibility permission confirmed.");
        }

        // ── Retry loop — recreate CGEventTap if rdev fails ────────────────
        loop {
            let tx = tx.clone();

            let mut press_time: Option<Instant> = None;
            let mut last_press = Instant::now();
            let mut click_count: u32 = 0;

            eprintln!("[pluks] rdev listener starting...");

            use rdev::{listen, Button, Event, EventType};

            let result = listen(move |event: Event| {
                match event.event_type {
                    EventType::ButtonPress(Button::Left) => {
                        let now = Instant::now();
                        if now.duration_since(last_press) < Duration::from_millis(500) {
                            click_count += 1;
                        } else {
                            click_count = 1;
                        }
                        last_press = now;
                        press_time = Some(now);
                        eprintln!("[pluks] MouseDown click#{}", click_count);
                    }
                    EventType::ButtonRelease(Button::Left) => {
                        let held_ms = press_time
                            .map(|t| t.elapsed().as_millis())
                            .unwrap_or(0);
                        press_time = None;

                        // A drag-select holds the button for >120ms.
                        // A quick single click is usually <120ms — skip it.
                        let is_drag = held_ms > 120;
                        let is_multi_click = click_count >= 2;

                        eprintln!(
                            "[pluks] MouseUp held={}ms drag={} multi={} clicks={}",
                            held_ms, is_drag, is_multi_click, click_count
                        );

                        if is_drag || is_multi_click {
                            eprintln!("[pluks] SelectionSignal sent!");
                            let _ = tx.send(SelectionSignal);
                            if is_multi_click {
                                click_count = 0;
                            }
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
