import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  getSettings,
  resetAnonymousId,
  setCrashOptOut,
  setLongPressEnabled,
  setOptOut,
  setShowNudges,
  track,
  type Settings,
} from "./analytics";

interface Props {
  onClose: () => void;
}

// System permissions only apply to macOS — Windows/Linux builds don't gate
// the watcher behind OS-level grants. Detect at render time (not module
// load) so tests can stub navigator.platform per-case; the cost is one
// string check per render, which is invisible next to React's own work.
function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const raw =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    "";
  return raw.toLowerCase().includes("mac");
}

// How often to re-poll the OS for permission state while Preferences is open.
// Matches App.tsx's setup-screen polling cadence — fast enough that the row
// flips to ✓ within a couple of seconds of granting in System Settings,
// slow enough that the IPC traffic is invisible.
const PERMISSION_POLL_MS = 2000;

interface PermissionRowSpec {
  key: "accessibility" | "input_monitoring";
  title: string;
  desc: string;
  checkCmd: string;
  openCmd: string;
}

const PERMISSION_ROWS: PermissionRowSpec[] = [
  {
    key: "accessibility",
    title: "Accessibility",
    desc: "Lets Pluks simulate Cmd+C to copy your selection.",
    checkCmd: "check_accessibility",
    openCmd: "open_accessibility_settings",
  },
  {
    key: "input_monitoring",
    title: "Input Monitoring",
    desc: "Lets Pluks detect when you select text with your mouse.",
    checkCmd: "check_input_monitoring",
    openCmd: "open_input_monitoring_settings",
  },
];

export default function PreferencesScreen({ onClose: _onClose }: Props) {
  const [settings, setSettings] = useState<Settings | null>(getSettings());
  const [resetting, setResetting] = useState(false);
  // Undefined until the first check resolves — distinguishes "still loading"
  // from "definitely not granted" so we don't briefly show a red Not granted
  // pill on a system where the permission is actually fine.
  const [perms, setPerms] = useState<{ accessibility?: boolean; input_monitoring?: boolean }>({});
  const isMac = isMacPlatform();

  useEffect(() => {
    // Settings are loaded once at boot; re-read in case they changed.
    setSettings(getSettings());
  }, []);

  // Live permission status. Poll while Preferences is open — the user may
  // bounce out to System Settings, toggle a switch, and come back; without
  // polling the row would still show the stale "Not granted" until the
  // panel is closed and re-opened. Skipped entirely off-macOS where the
  // backend commands aren't registered.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!isMac) return;
    let cancelled = false;
    const refresh = () => {
      for (const row of PERMISSION_ROWS) {
        invoke<boolean>(row.checkCmd).then(v => {
          if (cancelled) return;
          setPerms(prev => (prev[row.key] === v ? prev : { ...prev, [row.key]: v }));
        }).catch(() => {
          if (cancelled) return;
          // Treat IPC failure as "not granted" — safer than implying the
          // permission is fine when we can't actually tell.
          setPerms(prev => (prev[row.key] === false ? prev : { ...prev, [row.key]: false }));
        });
      }
    };
    refresh();
    pollRef.current = setInterval(refresh, PERMISSION_POLL_MS);
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [isMac]);

  if (!settings) {
    return (
      <div className="prefs-screen">
        <p className="setup-hint">Loading preferences…</p>
      </div>
    );
  }

  const onToggleAnalytics = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const enabled = e.target.checked;
    await setOptOut(!enabled);
    setSettings({ ...settings, opt_out: !enabled });
  };

  const onToggleCrash = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const enabled = e.target.checked;
    await setCrashOptOut(!enabled);
    setSettings({ ...settings, crash_opt_out: !enabled });
  };

  const onToggleLongPress = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const enabled = e.target.checked;
    await setLongPressEnabled(enabled);
    setSettings({ ...settings, enable_long_press_paste: enabled });
  };

  const onToggleNudges = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const enabled = e.target.checked;
    await setShowNudges(enabled);
    setSettings({ ...settings, show_nudges: enabled });
  };

  const onResetId = async () => {
    setResetting(true);
    await resetAnonymousId();
    const next = getSettings();
    if (next) setSettings(next);
    setResetting(false);
  };

  const onGrant = (row: PermissionRowSpec) => {
    track("permission_grant_clicked", { permission: row.key, source: "preferences" });
    invoke(row.openCmd);
  };

  return (
    <div className="prefs-screen">
      <h2 className="prefs-title">Preferences</h2>

      {isMac && (
        <section className="prefs-section">
          <h3 className="prefs-section-title">System permissions</h3>
          <div className="prefs-perm-list">
            {PERMISSION_ROWS.map(row => {
              const status = perms[row.key];
              const granted = status === true;
              const loading = status === undefined;
              return (
                <div
                  key={row.key}
                  className={`prefs-perm-row ${granted ? "granted" : loading ? "loading" : "missing"}`}
                >
                  <div className="prefs-perm-body">
                    <div className="prefs-perm-title">{row.title}</div>
                    <div className="prefs-perm-desc">{row.desc}</div>
                  </div>
                  <div className="prefs-perm-status-col">
                    <span className="prefs-perm-status" aria-live="polite">
                      {loading ? "Checking…" : granted ? "✓ Granted" : "Not granted"}
                    </span>
                    {!granted && !loading && (
                      <button
                        className="prefs-perm-btn"
                        onClick={() => onGrant(row)}
                        aria-label={`Grant ${row.title} permission`}
                      >
                        Grant →
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="prefs-perm-hint">
            Granting opens System Settings and prompts macOS to re-add Pluks to
            the list — status updates here automatically.
          </p>
        </section>
      )}

      <section className="prefs-section">
        <h3 className="prefs-section-title">Gestures</h3>

        <label className="prefs-toggle">
          <input
            type="checkbox"
            checked={settings.enable_long_press_paste}
            onChange={onToggleLongPress}
          />
          <span className="prefs-toggle-label">
            <strong>Press-and-hold to paste</strong>
            <span className="prefs-toggle-hint">
              Hold the mouse for half a second anywhere to open a wheel of
              recent clips. Drag to one, let go to paste.
            </span>
          </span>
        </label>

        <label className="prefs-toggle">
          <input
            type="checkbox"
            checked={settings.show_nudges}
            onChange={onToggleNudges}
          />
          <span className="prefs-toggle-label">
            <strong>Show nudges</strong>
            <span className="prefs-toggle-hint">
              Flash a small confirmation near the cursor after each capture
              and paste. Turn off if it feels too chatty.
            </span>
          </span>
        </label>
      </section>

      <section className="prefs-section">
        <h3 className="prefs-section-title">Privacy &amp; data</h3>

        <label className="prefs-toggle">
          <input
            type="checkbox"
            checked={!settings.opt_out}
            onChange={onToggleAnalytics}
          />
          <span className="prefs-toggle-label">
            <strong>Send anonymous usage stats</strong>
            <span className="prefs-toggle-hint">
              Event counts only — never the text you copy. Helps us prioritize what to build.
            </span>
          </span>
        </label>

        <label className="prefs-toggle">
          <input
            type="checkbox"
            checked={!settings.crash_opt_out}
            onChange={onToggleCrash}
          />
          <span className="prefs-toggle-label">
            <strong>Send crash reports</strong>
            <span className="prefs-toggle-hint">
              Stack traces with home directory paths scrubbed. Helps us fix bugs you hit.
            </span>
          </span>
        </label>

        <p className="prefs-meta prefs-password-note">
          <strong>Password fields are skipped automatically.</strong> When focus
          is inside a secure text input (login, unlock prompt, password
          manager), Pluks never simulates a copy and nothing lands in history.
        </p>
      </section>

      <section className="prefs-section">
        <h3 className="prefs-section-title">Anonymous ID</h3>
        <p className="prefs-mono">{settings.anon_id}</p>
        <button className="prefs-btn" onClick={onResetId} disabled={resetting}>
          {resetting ? "Resetting…" : "Reset anonymous ID"}
        </button>
      </section>

      <section className="prefs-section">
        <h3 className="prefs-section-title">About</h3>
        <p className="prefs-meta">Pluks v{settings.last_seen_version || "?"}</p>
        <p className="prefs-meta">See <code>pluks.app/privacy.html</code> for the full privacy policy.</p>
      </section>
    </div>
  );
}
