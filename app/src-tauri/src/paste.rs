//! Long-press paste — a radial menu of recent clips on a still hold.
//!
//! Subscribes to the low-level `MouseEvent` stream forwarded by
//! `selection.rs`, runs a small state machine to detect "press and hold
//! without moving for ~350 ms" anywhere on the OS, and drives a
//! transparent radial window that shows the user's most recent clips.
//! Releasing on a slice pastes that clip into whatever app was active
//! when the press began.
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
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State};

use crate::selection::{
    activate_pid, focus_is_secure_field, frontmost_pid, simulate_paste, write_clipboard,
    MouseEvent,
};
use crate::settings;
use crate::AppState;

pub const WIN_RADIAL: &str = "radial";

const LONG_PRESS_MS: u64 = 350;
const DRAG_PIXEL_THRESHOLD: f64 = 4.0;
const RADIAL_SIZE: f64 = 260.0;
const DEAD_ZONE_PX: f64 = 36.0;
const OUTER_RADIUS_PX: f64 = 120.0;
pub const SLICE_COUNT: usize = 5;
const POST_ACTIVATE_SLEEP_MS: u64 = 80;

const EVT_RADIAL_SHOW: &str = "radial-show";
const EVT_RADIAL_HIGHLIGHT: &str = "radial-highlight";
const EVT_RADIAL_HIDE: &str = "radial-hide";
const EVT_RADIAL_SUPPRESSED: &str = "radial-suppressed";

#[derive(Debug)]
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
    Fired {
        center_x: f64,
        center_y: f64,
        highlight: i8,
    },
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
    match (fsm, ev) {
        // A second Down without an intervening Up shouldn't happen on a real
        // device, but be defensive: hide any stale radial and start fresh.
        (FsmState::Fired { .. }, MouseEvent::Down { x, y }) => {
            hide_radial(app);
            state.set_target_pid(None);
            FsmState::Armed {
                press_x: x,
                press_y: y,
                press_at: Instant::now(),
            }
        }
        (_, MouseEvent::Down { x, y }) => FsmState::Armed {
            press_x: x,
            press_y: y,
            press_at: Instant::now(),
        },

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
                FsmState::Disarmed
            } else if press_at.elapsed() >= Duration::from_millis(LONG_PRESS_MS) {
                try_fire(press_x, press_y, state, app)
            } else {
                FsmState::Armed {
                    press_x,
                    press_y,
                    press_at,
                }
            }
        }

        (FsmState::Armed { .. }, MouseEvent::Up { .. }) => FsmState::Idle,
        (FsmState::Disarmed, MouseEvent::Move { .. }) => FsmState::Disarmed,
        (FsmState::Disarmed, MouseEvent::Up { .. }) => FsmState::Idle,

        (
            FsmState::Fired {
                center_x,
                center_y,
                highlight,
            },
            MouseEvent::Move { x, y },
        ) => {
            let new_slice = compute_slice(x - center_x, y - center_y);
            if new_slice != highlight {
                let _ = app.emit(
                    EVT_RADIAL_HIGHLIGHT,
                    json!({ "index": new_slice, "inside": new_slice >= 0 }),
                );
            }
            FsmState::Fired {
                center_x,
                center_y,
                highlight: new_slice,
            }
        }

        (
            FsmState::Fired {
                center_x,
                center_y,
                highlight: _,
            },
            MouseEvent::Up { x, y },
        ) => {
            let slice = compute_slice(x - center_x, y - center_y);
            commit_or_cancel(slice, state, app);
            FsmState::Idle
        }

        (FsmState::Idle, _) => FsmState::Idle,
    }
}

fn try_fire(x: f64, y: f64, state: &Arc<AppState>, app: &AppHandle) -> FsmState {
    let cfg = settings::load_or_init(app);
    if !cfg.enable_long_press_paste {
        emit_suppressed(app, "disabled");
        return FsmState::Disarmed;
    }
    if let Some(win) = app.get_webview_window(crate::WIN_HISTORY) {
        if win.is_visible().unwrap_or(false) {
            emit_suppressed(app, "panel_visible");
            return FsmState::Disarmed;
        }
    }
    if focus_is_secure_field() {
        emit_suppressed(app, "secure_field");
        return FsmState::Disarmed;
    }
    let items: Vec<_> = state
        .db()
        .get_all()
        .unwrap_or_default()
        .into_iter()
        .take(SLICE_COUNT)
        .collect();
    if items.is_empty() {
        emit_suppressed(app, "empty_history");
        return FsmState::Disarmed;
    }

    // Capture which app owned the press so paste lands there even if the
    // user's focus drifts elsewhere before they release.
    let our_pid = std::process::id() as i32;
    let target = frontmost_pid().filter(|&p| p != our_pid);
    state.set_target_pid(target);

    let Some(win) = app.get_webview_window(WIN_RADIAL) else {
        emit_suppressed(app, "no_window");
        return FsmState::Disarmed;
    };
    let _ = win.set_position(LogicalPosition::new(
        x - RADIAL_SIZE / 2.0,
        y - RADIAL_SIZE / 2.0,
    ));
    let _ = win.set_size(LogicalSize::new(RADIAL_SIZE, RADIAL_SIZE));
    let _ = win.show();

    let _ = win.emit(
        EVT_RADIAL_SHOW,
        json!({ "items": items, "center": { "x": x, "y": y } }),
    );

    FsmState::Fired {
        center_x: x,
        center_y: y,
        highlight: -1,
    }
}

fn commit_or_cancel(slice: i8, state: &Arc<AppState>, app: &AppHandle) {
    hide_radial(app);

    if slice < 0 {
        let _ = app.emit(
            EVT_RADIAL_HIDE,
            json!({ "reason": "cancelled", "index": slice }),
        );
        state.set_target_pid(None);
        return;
    }

    // Re-query rather than trusting the snapshot from `radial-show` —
    // a new selection could have landed between fire and release.
    let items = state.db().get_all().unwrap_or_default();
    let Some(item) = items.get(slice as usize) else {
        let _ = app.emit(
            EVT_RADIAL_HIDE,
            json!({ "reason": "cancelled", "index": slice }),
        );
        state.set_target_pid(None);
        return;
    };
    let content = item.content.clone();
    let char_count = content.chars().count();

    if !write_clipboard(&content) {
        let _ = app.emit(
            EVT_RADIAL_HIDE,
            json!({ "reason": "clipboard_failed", "index": slice }),
        );
        state.set_target_pid(None);
        return;
    }
    if let Some(pid) = state.take_target_pid() {
        activate_pid(pid);
        thread::sleep(Duration::from_millis(POST_ACTIVATE_SLEEP_MS));
    }
    simulate_paste();

    let _ = app.emit(
        EVT_RADIAL_HIDE,
        json!({
            "reason": "committed",
            "index": slice,
            "char_count": char_count,
        }),
    );
}

fn hide_radial(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(WIN_RADIAL) {
        let _ = win.hide();
    }
}

fn emit_suppressed(app: &AppHandle, reason: &str) {
    let _ = app.emit(EVT_RADIAL_SUPPRESSED, json!({ "reason": reason }));
}

/// Slice index from cursor offset relative to radial center. Slice 0 is at
/// 12 o'clock, indices grow clockwise. Returns -1 for the central dead-zone
/// (too close to commit) or outside the outer ring (release-to-cancel).
fn compute_slice(dx: f64, dy: f64) -> i8 {
    let r2 = dx * dx + dy * dy;
    if r2 < DEAD_ZONE_PX * DEAD_ZONE_PX {
        return -1;
    }
    if r2 > OUTER_RADIUS_PX * OUTER_RADIUS_PX {
        return -1;
    }
    // atan2(dx, -dy): 0 rad = up, +π/2 = right, ±π = down, -π/2 = left.
    // Screen Y grows downward, so "up" is -dy.
    let theta = dx.atan2(-dy);
    let mut deg = theta.to_degrees();
    if deg < 0.0 {
        deg += 360.0;
    }
    let step = 360.0 / SLICE_COUNT as f64;
    let i = ((deg / step).round() as i64).rem_euclid(SLICE_COUNT as i64);
    i as i8
}

// ── Tauri commands ─────────────────────────────────────────────────────────

/// Safety valve: explicit dismiss in case the FSM ever ends up Fired with no
/// corresponding mouse-up (Spaces switch eating the event, dev rebuild, etc.).
#[tauri::command]
pub fn radial_dismiss(app: AppHandle, state: State<Arc<AppState>>) {
    hide_radial(&app);
    state.set_target_pid(None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slice_top_is_zero() {
        assert_eq!(compute_slice(0.0, -80.0), 0);
    }

    #[test]
    fn slice_clockwise_progression() {
        let r = 80.0;
        for i in 0..SLICE_COUNT {
            let theta = (i as f64 * 360.0 / SLICE_COUNT as f64).to_radians();
            let dx = r * theta.sin();
            let dy = -r * theta.cos();
            assert_eq!(compute_slice(dx, dy), i as i8, "slice {i}");
        }
    }

    #[test]
    fn slice_dead_zone_returns_minus_one() {
        assert_eq!(compute_slice(0.0, 0.0), -1);
        assert_eq!(compute_slice(20.0, 20.0), -1);
    }

    #[test]
    fn slice_outside_outer_radius_returns_minus_one() {
        assert_eq!(compute_slice(0.0, -200.0), -1);
        assert_eq!(compute_slice(200.0, 0.0), -1);
    }

    #[test]
    fn slice_wraps_around_north_correctly() {
        let r = 80.0;
        for off_deg in [-10.0_f64, 10.0_f64] {
            let theta = off_deg.to_radians();
            let dx = r * theta.sin();
            let dy = -r * theta.cos();
            assert_eq!(compute_slice(dx, dy), 0, "offset {off_deg}°");
        }
    }
}
