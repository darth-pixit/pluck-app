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
    activate_pid, clipboard_is_concealed, focus_is_secure_field, frontmost_pid, read_clipboard,
    simulate_paste, Clipboard, MouseEvent,
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
    /// The clipboard holds a copy Pluks didn't write and the poller hasn't
    /// recorded yet: record it, then paste it — no clipboard write needed,
    /// the content is already there.
    PasteFresh { content: String, char_count: usize },
    /// The clipboard matches the last recorded clip (or is empty, unreadable,
    /// or concealed): paste the most-recent history item, re-writing it to
    /// the clipboard first.
    PasteRecent { content: String, char_count: usize },
}

/// Pure decision: given the gate inputs, the current clipboard, and the
/// most-recent clip, do we paste, and which content? Split out so the
/// suppression matrix is testable without tauri / FFI dependencies.
fn decide_fire(
    enabled: bool,
    panel_visible: bool,
    secure_field: bool,
    clipboard_text: Option<String>,
    last_recorded: Option<&str>,
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
    // A clipboard value Pluks didn't put there is a manual copy the poller
    // hasn't banked yet (its tick is 500 ms; a long-press fires after 350 ms,
    // so copy-then-hold races ahead of it). That clip — not the possibly
    // stale DB top row — is "what I just copied", so it wins. Writing the DB
    // row over it here would also destroy the copy before it ever reached
    // history.
    if let Some(text) = clipboard_text {
        if last_recorded != Some(text.as_str()) {
            let char_count = text.chars().count();
            return FireDecision::PasteFresh {
                content: text,
                char_count,
            };
        }
    }
    let Some(item) = most_recent else {
        return FireDecision::Skip("empty_history");
    };
    let char_count = item.content.chars().count();
    FireDecision::PasteRecent {
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
    // Privacy gate mirrors the clipboard poller: a concealed clipboard
    // (password-manager flagged) is never read, so it can't paste fresh and
    // the decision falls back to history.
    let clipboard_text = if clipboard_is_concealed() {
        None
    } else {
        read_clipboard(&mut Clipboard::new().ok())
    };
    let most_recent = state
        .db()
        .get_all()
        .unwrap_or_default()
        .into_iter()
        .next();

    let (content, char_count, fresh) = match decide_fire(
        cfg.enable_long_press_paste,
        panel_visible,
        focus_is_secure_field(),
        clipboard_text,
        state.last_recorded_clip().as_deref(),
        most_recent,
    ) {
        FireDecision::Skip(reason) => {
            crate::elog!("[pluks] try_fire: suppressed {}", reason);
            let _ = app.emit(EVT_PASTE_SUPPRESSED, json!({ "reason": reason }));
            return FsmState::Disarmed;
        }
        FireDecision::PasteFresh {
            content,
            char_count,
        } => (content, char_count, true),
        FireDecision::PasteRecent {
            content,
            char_count,
        } => (content, char_count, false),
    };

    // Capture which app owned the press so paste lands there even if
    // focus drifts before we synthesize Cmd+V.
    let our_pid = std::process::id() as i32;
    let target = frontmost_pid().filter(|&p| p != our_pid);
    state.set_target_pid(target);

    if fresh {
        // The content is already on the clipboard; bank it into history now
        // (the poller would only get to it up to one tick later). Paste
        // proceeds even if the insert fails — Cmd+V reads the clipboard, not
        // the DB — and a failed insert leaves the clip unstamped so the
        // poller retries it.
        if let Err(e) = crate::record_clip(app, state, &content) {
            crate::elog!("[pluks] try_fire: fresh clip record failed: {e}");
        }
    } else {
        // Remembered write: long-press puts the most-recent clip back on
        // the clipboard, and the poller must not re-record that as a fresh
        // external copy.
        if !state.write_clipboard_remembered(&content) {
            crate::elog!("[pluks] try_fire: clipboard write failed");
            let _ = app.emit(EVT_PASTE_SUPPRESSED, json!({ "reason": "clipboard_failed" }));
            state.set_target_pid(None);
            return FsmState::Disarmed;
        }
    }
    if let Some(pid) = state.take_target_pid() {
        activate_pid(pid);
        thread::sleep(Duration::from_millis(POST_ACTIVATE_SLEEP_MS));
    }
    simulate_paste();

    crate::show_paste_confirm(app, state, x, y, char_count);

    FsmState::Disarmed
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
        let d = decide_fire(true, false, false, None, None, Some(item("hello world")));
        assert_eq!(
            d,
            FireDecision::PasteRecent {
                content: "hello world".into(),
                char_count: 11,
            },
        );
    }

    #[test]
    fn fire_skips_when_disabled() {
        let d = decide_fire(false, false, false, None, None, Some(item("x")));
        assert_eq!(d, FireDecision::Skip("disabled"));
    }

    #[test]
    fn fire_skips_when_history_panel_is_visible() {
        let d = decide_fire(true, true, false, None, None, Some(item("x")));
        assert_eq!(d, FireDecision::Skip("panel_visible"));
    }

    #[test]
    fn fire_skips_when_focus_is_on_a_secure_field() {
        let d = decide_fire(true, false, true, None, None, Some(item("secret")));
        assert_eq!(d, FireDecision::Skip("secure_field"));
    }

    #[test]
    fn fire_skips_when_history_is_empty() {
        let d = decide_fire(true, false, false, None, None, None);
        assert_eq!(d, FireDecision::Skip("empty_history"));
    }

    #[test]
    fn fire_counts_chars_not_bytes_for_unicode() {
        let d = decide_fire(true, false, false, None, None, Some(item("café 🚀")));
        match d {
            FireDecision::PasteRecent { char_count, .. } => assert_eq!(char_count, 6),
            _ => panic!("expected PasteRecent"),
        }
    }

    // ── Fresh-clipboard precedence (manual copy → immediate long-press) ──

    #[test]
    fn fresh_clipboard_wins_over_stale_db_top() {
        // A manual copy the poller hasn't recorded yet: clipboard differs
        // from the last clip Pluks wrote/recorded. The DB top row is stale.
        let d = decide_fire(
            true,
            false,
            false,
            Some("just copied".into()),
            Some("older clip"),
            Some(item("older clip")),
        );
        assert_eq!(
            d,
            FireDecision::PasteFresh {
                content: "just copied".into(),
                char_count: 11,
            },
        );
    }

    #[test]
    fn clipboard_matching_last_recorded_falls_back_to_history() {
        // The clipboard still holds Pluks's own last write — that's an echo,
        // not a fresh copy, so the DB most-recent is the right content.
        let d = decide_fire(
            true,
            false,
            false,
            Some("top clip".into()),
            Some("top clip"),
            Some(item("top clip")),
        );
        assert_eq!(
            d,
            FireDecision::PasteRecent {
                content: "top clip".into(),
                char_count: 8,
            },
        );
    }

    #[test]
    fn fresh_clipboard_with_no_last_recorded_is_fresh() {
        // First copy after startup: nothing recorded yet, clipboard has text.
        let d = decide_fire(true, false, false, Some("first".into()), None, None);
        assert_eq!(
            d,
            FireDecision::PasteFresh {
                content: "first".into(),
                char_count: 5,
            },
        );
    }

    #[test]
    fn fresh_clipboard_pastes_even_with_empty_history() {
        let d = decide_fire(
            true,
            false,
            false,
            Some("only on clipboard".into()),
            Some("something else"),
            None,
        );
        assert!(matches!(d, FireDecision::PasteFresh { .. }));
    }

    #[test]
    fn gates_still_suppress_a_fresh_clipboard() {
        let fresh = || Some(String::from("just copied"));
        assert_eq!(
            decide_fire(false, false, false, fresh(), None, None),
            FireDecision::Skip("disabled"),
        );
        assert_eq!(
            decide_fire(true, true, false, fresh(), None, None),
            FireDecision::Skip("panel_visible"),
        );
        assert_eq!(
            decide_fire(true, false, true, fresh(), None, None),
            FireDecision::Skip("secure_field"),
        );
    }

    #[test]
    fn fresh_clipboard_counts_chars_not_bytes() {
        let d = decide_fire(true, false, false, Some("café 🚀".into()), None, None);
        match d {
            FireDecision::PasteFresh { char_count, .. } => assert_eq!(char_count, 6),
            _ => panic!("expected PasteFresh"),
        }
    }
}
