//! Long-press paste — silently paste the most recent clip on a still hold.
//!
//! Subscribes to the low-level `MouseEvent` stream forwarded by
//! `selection.rs`, runs a small state machine to detect "press and hold
//! without moving for ~350 ms" anywhere on the OS, and pastes the most
//! recent clip into whatever app was active when the press began. A
//! whisper-quiet confirmation pill flashes near the press point for
//! ~2 s afterwards (rendered by the existing nudge window). Most paste
//! cases are "paste what I just copied"; ⌃⇧V handles the long tail.
//!
//! Gesture rule: **movement wins**. Any pointer motion above the existing
//! `DRAG_PIXEL_THRESHOLD` before 350 ms permanently disarms long-press
//! for that press cycle — the press is then handled exclusively by the
//! select-to-copy path in `lib.rs`. Once disarmed, a pause does *not*
//! retroactively re-arm.

use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::history::HistoryItem;
use crate::selection::{
    activate_pid, focus_is_secure_field, frontmost_pid, simulate_paste, MouseEvent,
};
use crate::settings;
use crate::AppState;

const LONG_PRESS_MS: u64 = 350;
const DRAG_PIXEL_THRESHOLD: f64 = 4.0;
const POST_ACTIVATE_SLEEP_MS: u64 = 80;

const EVT_PASTE_SUPPRESSED: &str = "paste-suppressed";

#[derive(Debug, Clone)]
enum FsmState {
    Idle,
    Armed {
        press_x: f64,
        press_y: f64,
        press_at: Instant,
    },
    /// Saw motion above threshold during arming. Stays here until the
    /// current press cycle ends — a later "stillness" must not retroactively
    /// re-arm the long-press.
    Disarmed,
}

/// Outcome of a single FSM step. Pure — kept separate from `try_fire` so the
/// transition table can be unit-tested without an `AppHandle` / `AppState`.
#[derive(Debug)]
enum Step {
    Continue(FsmState),
    Fire { press_x: f64, press_y: f64 },
}

pub fn start_paste_processor(
    rx_mouse: mpsc::Receiver<MouseEvent>,
    state: Arc<AppState>,
    app: AppHandle,
) {
    thread::spawn(move || {
        let mut fsm = FsmState::Idle;
        loop {
            // While Armed, the receive timeout wakes us when the long-press
            // window elapses so we can fire even without any intervening
            // mouse events. Otherwise we wait effectively forever for the
            // next mouse event.
            let timeout = match &fsm {
                FsmState::Armed { press_at, .. } => {
                    let target = Duration::from_millis(LONG_PRESS_MS);
                    let elapsed = press_at.elapsed();
                    if elapsed >= target {
                        Duration::from_millis(0)
                    } else {
                        target - elapsed
                    }
                }
                _ => Duration::from_secs(3600),
            };
            match rx_mouse.recv_timeout(timeout) {
                Ok(ev) => fsm = handle_event(fsm, ev, &state, &app),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if let FsmState::Armed {
                        press_x, press_y, ..
                    } = fsm
                    {
                        fsm = try_fire(press_x, press_y, &state, &app);
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    });
}

fn handle_event(
    fsm: FsmState,
    ev: MouseEvent,
    state: &Arc<AppState>,
    app: &AppHandle,
) -> FsmState {
    match fsm_step(fsm, ev) {
        Step::Continue(next) => next,
        Step::Fire { press_x, press_y } => try_fire(press_x, press_y, state, app),
    }
}

fn fsm_step(fsm: FsmState, ev: MouseEvent) -> Step {
    match (fsm, ev) {
        (_, MouseEvent::Down { x, y }) => Step::Continue(FsmState::Armed {
            press_x: x,
            press_y: y,
            press_at: Instant::now(),
        }),

        (
            FsmState::Armed {
                press_x,
                press_y,
                press_at,
            },
            MouseEvent::Move { x, y },
        ) => {
            let dx = (x - press_x).abs();
            let dy = (y - press_y).abs();
            if dx > DRAG_PIXEL_THRESHOLD || dy > DRAG_PIXEL_THRESHOLD {
                Step::Continue(FsmState::Disarmed)
            } else if press_at.elapsed() >= Duration::from_millis(LONG_PRESS_MS) {
                Step::Fire { press_x, press_y }
            } else {
                Step::Continue(FsmState::Armed {
                    press_x,
                    press_y,
                    press_at,
                })
            }
        }

        (FsmState::Armed { .. }, MouseEvent::Up) => Step::Continue(FsmState::Idle),
        (FsmState::Disarmed, MouseEvent::Move { .. }) => Step::Continue(FsmState::Disarmed),
        (FsmState::Disarmed, MouseEvent::Up) => Step::Continue(FsmState::Idle),

        (FsmState::Idle, _) => Step::Continue(FsmState::Idle),
    }
}

#[derive(Debug, PartialEq)]
enum FireDecision {
    Skip(&'static str),
    Paste { content: String, char_count: usize },
}

/// Pure decision: given the gate inputs and the most-recent clip, do we
/// paste, and which content? Split out so the suppression matrix is
/// testable without tauri / FFI dependencies.
fn decide_fire(
    enabled: bool,
    panel_visible: bool,
    secure_field: bool,
    most_recent: Option<HistoryItem>,
) -> FireDecision {
    if !enabled {
        return FireDecision::Skip("disabled");
    }
    if panel_visible {
        return FireDecision::Skip("panel_visible");
    }
    if secure_field {
        return FireDecision::Skip("secure_field");
    }
    let Some(item) = most_recent else {
        return FireDecision::Skip("empty_history");
    };
    let char_count = item.content.chars().count();
    FireDecision::Paste {
        content: item.content,
        char_count,
    }
}

fn try_fire(x: f64, y: f64, state: &Arc<AppState>, app: &AppHandle) -> FsmState {
    let cfg = settings::load_or_init(app);
    let panel_visible = app
        .get_webview_window(crate::WIN_HISTORY)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    let most_recent = state
        .db()
        .get_all()
        .unwrap_or_default()
        .into_iter()
        .next();

    match decide_fire(
        cfg.enable_long_press_paste,
        panel_visible,
        focus_is_secure_field(),
        most_recent,
    ) {
        FireDecision::Skip(reason) => {
            eprintln!("[pluks] try_fire: suppressed {}", reason);
            let _ = app.emit(EVT_PASTE_SUPPRESSED, json!({ "reason": reason }));
            FsmState::Disarmed
        }
        FireDecision::Paste {
            content,
            char_count,
        } => {
            // Capture which app owned the press so paste lands there even if
            // focus drifts before we synthesize Cmd+V.
            let our_pid = std::process::id() as i32;
            let target = frontmost_pid().filter(|&p| p != our_pid);
            state.set_target_pid(target);

            // Remembered write: long-press puts the most-recent clip back on
            // the clipboard, and the poller must not re-record that as a fresh
            // external copy.
            if !state.write_clipboard_remembered(&content) {
                eprintln!("[pluks] try_fire: clipboard write failed");
                let _ = app.emit(EVT_PASTE_SUPPRESSED, json!({ "reason": "clipboard_failed" }));
                state.set_target_pid(None);
                return FsmState::Disarmed;
            }
            if let Some(pid) = state.take_target_pid() {
                activate_pid(pid);
                thread::sleep(Duration::from_millis(POST_ACTIVATE_SLEEP_MS));
            }
            simulate_paste();

            crate::show_paste_confirm(app, state, x, y, char_count);

            FsmState::Disarmed
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::HistoryItem;

    fn item(content: &str) -> HistoryItem {
        HistoryItem {
            id: 1,
            content: content.into(),
            copied_at: "2026-05-15T00:00:00Z".into(),
            char_count: content.chars().count(),
        }
    }

    fn matches_armed(s: &FsmState, x: f64, y: f64) -> bool {
        matches!(s, FsmState::Armed { press_x, press_y, .. } if *press_x == x && *press_y == y)
    }

    fn fresh_armed(x: f64, y: f64) -> FsmState {
        FsmState::Armed {
            press_x: x,
            press_y: y,
            press_at: Instant::now(),
        }
    }

    fn elapsed_armed(x: f64, y: f64) -> FsmState {
        FsmState::Armed {
            press_x: x,
            press_y: y,
            press_at: Instant::now() - Duration::from_millis(LONG_PRESS_MS + 50),
        }
    }

    // ── FSM transition table ──────────────────────────────────────────────

    #[test]
    fn down_arms_from_idle() {
        let step = fsm_step(FsmState::Idle, MouseEvent::Down { x: 100.0, y: 100.0 });
        match step {
            Step::Continue(s) => assert!(matches_armed(&s, 100.0, 100.0)),
            _ => panic!("expected Continue(Armed)"),
        }
    }

    #[test]
    fn down_after_disarmed_re_arms() {
        let step = fsm_step(FsmState::Disarmed, MouseEvent::Down { x: 50.0, y: 60.0 });
        match step {
            Step::Continue(s) => assert!(matches_armed(&s, 50.0, 60.0)),
            _ => panic!("expected re-arm"),
        }
    }

    #[test]
    fn move_within_threshold_keeps_armed() {
        let step = fsm_step(fresh_armed(100.0, 100.0), MouseEvent::Move { x: 102.0, y: 100.0 });
        match step {
            Step::Continue(s) => assert!(matches_armed(&s, 100.0, 100.0)),
            _ => panic!("small motion must not change state"),
        }
    }

    #[test]
    fn move_beyond_threshold_disarms() {
        let step = fsm_step(fresh_armed(100.0, 100.0), MouseEvent::Move { x: 110.0, y: 100.0 });
        assert!(matches!(step, Step::Continue(FsmState::Disarmed)));
    }

    #[test]
    fn move_after_long_press_fires() {
        // Above-threshold motion that arrives after the long-press window
        // still fires — the timeout guard wins over the drag check once
        // enough time has elapsed.
        let step = fsm_step(elapsed_armed(100.0, 100.0), MouseEvent::Move { x: 101.0, y: 100.0 });
        match step {
            Step::Fire { press_x, press_y } => {
                assert_eq!(press_x, 100.0);
                assert_eq!(press_y, 100.0);
            }
            _ => panic!("expected Fire"),
        }
    }

    #[test]
    fn up_from_armed_returns_to_idle() {
        let step = fsm_step(fresh_armed(50.0, 50.0), MouseEvent::Up);
        assert!(matches!(step, Step::Continue(FsmState::Idle)));
    }

    #[test]
    fn disarmed_stays_disarmed_on_move() {
        let step = fsm_step(FsmState::Disarmed, MouseEvent::Move { x: 1.0, y: 1.0 });
        assert!(matches!(step, Step::Continue(FsmState::Disarmed)));
    }

    #[test]
    fn disarmed_returns_to_idle_on_up() {
        let step = fsm_step(FsmState::Disarmed, MouseEvent::Up);
        assert!(matches!(step, Step::Continue(FsmState::Idle)));
    }

    #[test]
    fn idle_ignores_move_and_up() {
        assert!(matches!(
            fsm_step(FsmState::Idle, MouseEvent::Move { x: 1.0, y: 1.0 }),
            Step::Continue(FsmState::Idle)
        ));
        assert!(matches!(
            fsm_step(FsmState::Idle, MouseEvent::Up),
            Step::Continue(FsmState::Idle)
        ));
    }

    // ── Fire decision ─────────────────────────────────────────────────────

    #[test]
    fn fire_pastes_most_recent_clip_when_all_gates_pass() {
        let d = decide_fire(true, false, false, Some(item("hello world")));
        assert_eq!(
            d,
            FireDecision::Paste {
                content: "hello world".into(),
                char_count: 11,
            },
        );
    }

    #[test]
    fn fire_skips_when_disabled() {
        let d = decide_fire(false, false, false, Some(item("x")));
        assert_eq!(d, FireDecision::Skip("disabled"));
    }

    #[test]
    fn fire_skips_when_history_panel_is_visible() {
        let d = decide_fire(true, true, false, Some(item("x")));
        assert_eq!(d, FireDecision::Skip("panel_visible"));
    }

    #[test]
    fn fire_skips_when_focus_is_on_a_secure_field() {
        let d = decide_fire(true, false, true, Some(item("secret")));
        assert_eq!(d, FireDecision::Skip("secure_field"));
    }

    #[test]
    fn fire_skips_when_history_is_empty() {
        let d = decide_fire(true, false, false, None);
        assert_eq!(d, FireDecision::Skip("empty_history"));
    }

    #[test]
    fn fire_counts_chars_not_bytes_for_unicode() {
        let d = decide_fire(true, false, false, Some(item("café 🚀")));
        match d {
            FireDecision::Paste { char_count, .. } => assert_eq!(char_count, 6),
            _ => panic!("expected Paste"),
        }
    }
}
