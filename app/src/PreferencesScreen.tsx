import { useEffect, useState } from "react";
import { getSettings, resetAnonymousId, setCrashOptOut, setOptOut, track, type Settings } from "./analytics";

const FEEDBACK_EMAIL = "parthdixit.iitd@gmail.com";
const FEEDBACK_SUBJECT = "Pluks feedback";

interface Props {
  onClose: () => void;
}

export default function PreferencesScreen({ onClose: _onClose }: Props) {
  const [settings, setSettings] = useState<Settings | null>(getSettings());
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    // Settings are loaded once at boot; re-read in case they changed.
    setSettings(getSettings());
  }, []);

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

  const onResetId = async () => {
    setResetting(true);
    await resetAnonymousId();
    const next = getSettings();
    if (next) setSettings(next);
    setResetting(false);
  };

  return (
    <div className="prefs-screen">
      <h2 className="prefs-title">Preferences</h2>

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
      </section>

      <section className="prefs-section">
        <h3 className="prefs-section-title">Anonymous ID</h3>
        <p className="prefs-mono">{settings.anon_id}</p>
        <button className="prefs-btn" onClick={onResetId} disabled={resetting}>
          {resetting ? "Resetting…" : "Reset anonymous ID"}
        </button>
      </section>

      <section className="prefs-section">
        <h3 className="prefs-section-title">Feedback</h3>
        <p className="prefs-meta">
          Found a bug, have a feature request, or just want to say hi? Email the creator directly.
        </p>
        <a
          className="prefs-btn"
          href={`mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(FEEDBACK_SUBJECT)}`}
          onClick={() => track("feedback_clicked", { source: "preferences" })}
        >
          Send feedback →
        </a>
      </section>

      <section className="prefs-section">
        <h3 className="prefs-section-title">About</h3>
        <p className="prefs-meta">Pluks v{settings.last_seen_version || "?"}</p>
        <p className="prefs-meta">See <code>pluks.app/privacy.html</code> for the full privacy policy.</p>
      </section>
    </div>
  );
}
