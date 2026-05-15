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
    /// Long-press anywhere to silently paste the most recent clip. On by
    /// default; users who don't want a global hold gesture can disable it
    /// in Preferences. Older settings.json files (pre-feature) deserialize
    /// with the `default_true` helper rather than `Default::default()`,
    /// which would silently flip them to false on upgrade.
    #[serde(default = "default_true")]
    pub enable_long_press_paste: bool,
    /// Show the small floating "nudge" pill near the cursor after every
    /// auto-copy capture (and the analogous paste-side surfaces). On by
    /// default. When on, the affirmation fires on *every* selection — no
    /// adaptive decay — so the user (and we, during diagnostics on macOS
    /// builds where transparent overlay rendering changed under us — Tahoe
    /// 26.2 et al.) can verify the overlay pipeline is producing pixels at
    /// all. When off, every nudge surface is suppressed: affirmation,
    /// corrective, hold-affirmation, hold-discovery. Same `default_true`
    /// upgrade dance as `enable_long_press_paste` so pre-feature records
    /// don't silently flip to off.
    #[serde(default = "default_true")]
    pub show_nudges: bool,
}

fn default_true() -> bool { true }

impl Settings {
    pub(crate) fn fresh() -> Self {
        Self {
            anon_id: gen_uuid(),
            opt_out: false,
            crash_opt_out: false,
            analytics_first_seen_version: String::new(),
            last_seen_version: String::new(),
            enable_long_press_paste: true,
            show_nudges: true,
        }
    }
}

/// Load settings from a specific path, recovering with a fresh record on
/// missing or unparseable files. Pure function — no Tauri dependency, so we
/// can unit test it directly.
pub(crate) fn load_from_path(path: &PathBuf) -> Settings {
    match fs::read_to_string(path) {
        Ok(s) => serde_json::from_str::<Settings>(&s).unwrap_or_else(|_| {
            let fresh = Settings::fresh();
            let _ = save(path, &fresh);
            fresh
        }),
        Err(_) => {
            let fresh = Settings::fresh();
            let _ = save(path, &fresh);
            fresh
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
    load_from_path(&path)
}

pub(crate) fn save(path: &PathBuf, s: &Settings) -> std::io::Result<()> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn fresh_settings_has_uuid_v4_shape() {
        let s = Settings::fresh();
        // 8-4-4-4-12
        let parts: Vec<&str> = s.anon_id.split('-').collect();
        assert_eq!(parts.len(), 5);
        assert_eq!(parts[0].len(), 8);
        assert_eq!(parts[1].len(), 4);
        assert_eq!(parts[2].len(), 4);
        assert_eq!(parts[3].len(), 4);
        assert_eq!(parts[4].len(), 12);
        // Version nibble = 4
        let third = parts[2];
        assert!(third.starts_with('4'));
        // Variant = 8/9/a/b
        let fourth = parts[3];
        let v = fourth.chars().next().unwrap();
        assert!(matches!(v, '8' | '9' | 'a' | 'b'));
    }

    #[test]
    fn fresh_settings_have_safe_defaults() {
        let s = Settings::fresh();
        assert!(!s.opt_out);
        assert!(!s.crash_opt_out);
        assert!(s.analytics_first_seen_version.is_empty());
        assert!(s.last_seen_version.is_empty());
    }

    #[test]
    fn gen_uuid_uniqueness_over_many_calls() {
        let n = 256;
        let mut ids = std::collections::HashSet::new();
        for _ in 0..n {
            ids.insert(gen_uuid());
        }
        assert_eq!(ids.len(), n);
    }

    #[test]
    fn load_from_missing_path_writes_fresh_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("settings.json");
        assert!(!path.exists());
        let s = load_from_path(&path);
        assert!(path.exists(), "fresh save should land");
        assert!(!s.anon_id.is_empty());
    }

    #[test]
    fn load_roundtrips_through_save() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("settings.json");
        let mut s = Settings::fresh();
        s.opt_out = true;
        s.last_seen_version = "1.2.3".into();
        save(&path, &s).unwrap();
        let loaded = load_from_path(&path);
        assert_eq!(loaded.anon_id, s.anon_id);
        assert!(loaded.opt_out);
        assert_eq!(loaded.last_seen_version, "1.2.3");
    }

    #[test]
    fn load_recovers_from_corrupt_json_with_fresh_settings() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "this is not json").unwrap();
        let recovered = load_from_path(&path);
        assert!(!recovered.anon_id.is_empty());
        // The file was rewritten with the fresh record.
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains(&recovered.anon_id));
    }

    #[test]
    fn load_recovers_from_empty_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "").unwrap();
        let s = load_from_path(&path);
        assert!(!s.anon_id.is_empty());
    }

    #[test]
    fn save_overwrites_existing_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("settings.json");
        let s1 = Settings::fresh();
        save(&path, &s1).unwrap();
        let mut s2 = Settings::fresh();
        s2.last_seen_version = "9.9.9".into();
        save(&path, &s2).unwrap();
        let loaded = load_from_path(&path);
        assert_eq!(loaded.last_seen_version, "9.9.9");
        assert_eq!(loaded.anon_id, s2.anon_id);
    }

    #[test]
    fn deserialize_with_missing_optional_fields_uses_serde_defaults() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("settings.json");
        // Only the required field present — older record format.
        fs::write(&path, r#"{"anon_id":"old-record"}"#).unwrap();
        let s = load_from_path(&path);
        assert_eq!(s.anon_id, "old-record");
        assert!(!s.opt_out);
        assert!(!s.crash_opt_out);
        assert!(s.analytics_first_seen_version.is_empty());
        // Pre-feature records must upgrade with the long-press toggle ON —
        // matching the new-install default. A serde `default` would have
        // landed at `false` and silently disabled the feature.
        assert!(s.enable_long_press_paste);
        // Same upgrade guarantee for the nudge toggle.
        assert!(s.show_nudges);
    }

    #[test]
    fn fresh_enables_long_press_paste() {
        assert!(Settings::fresh().enable_long_press_paste);
    }

    #[test]
    fn fresh_enables_nudges() {
        assert!(Settings::fresh().show_nudges);
    }
}
