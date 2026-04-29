//! Pluks user settings — persisted to a small JSON file under `app_data_dir`.
//! Holds the anonymous analytics ID, opt-out toggles, and version markers.
//!
//! No PII. The anonymous ID is a UUIDv4 generated on first run and used as the
//! PostHog `distinct_id` and Sentry `user.id` from the JS layer.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

const SETTINGS_FILE: &str = "settings.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    pub anon_id: String,
    #[serde(default)]
    pub opt_out: bool,
    #[serde(default)]
    pub crash_opt_out: bool,
    #[serde(default)]
    pub analytics_first_seen_version: String,
    #[serde(default)]
    pub last_seen_version: String,
}

impl Settings {
    fn fresh() -> Self {
        Self {
            anon_id: gen_uuid(),
            opt_out: false,
            crash_opt_out: false,
            analytics_first_seen_version: String::new(),
            last_seen_version: String::new(),
        }
    }
}

fn gen_uuid() -> String {
    // Lightweight RFC-4122-shaped v4 UUID without pulling in a crate.
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let pid = std::process::id() as u128;
    let mut state: u128 = nanos.wrapping_mul(6364136223846793005).wrapping_add(pid);
    let mut bytes = [0u8; 16];
    for b in bytes.iter_mut() {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        *b = (state >> 64) as u8;
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
    let h = |i: usize| format!("{:02x}", bytes[i]);
    format!(
        "{}{}{}{}-{}{}-{}{}-{}{}-{}{}{}{}{}{}",
        h(0), h(1), h(2), h(3),
        h(4), h(5),
        h(6), h(7),
        h(8), h(9),
        h(10), h(11), h(12), h(13), h(14), h(15)
    )
}

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    Some(dir.join(SETTINGS_FILE))
}

pub fn load_or_init<R: Runtime>(app: &AppHandle<R>) -> Settings {
    let Some(path) = settings_path(app) else { return Settings::fresh() };
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str::<Settings>(&s).unwrap_or_else(|_| {
            let fresh = Settings::fresh();
            let _ = save(&path, &fresh);
            fresh
        }),
        Err(_) => {
            let fresh = Settings::fresh();
            let _ = save(&path, &fresh);
            fresh
        }
    }
}

fn save(path: &PathBuf, s: &Settings) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(s).unwrap_or_else(|_| "{}".into());
    fs::write(path, json)
}

#[tauri::command]
pub fn get_settings<R: Runtime>(app: AppHandle<R>) -> Settings {
    load_or_init(&app)
}

#[tauri::command]
pub fn set_settings<R: Runtime>(app: AppHandle<R>, settings: Settings) -> bool {
    let Some(path) = settings_path(&app) else { return false };
    save(&path, &settings).is_ok()
}
