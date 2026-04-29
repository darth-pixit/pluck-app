import { useEffect, useState } from "react";
import {
  installStagedUpdate,
  markUpdateNoticeDismissed,
  shouldShowNoticeFor,
  subscribeUpdateStatus,
  type UpdateStatus,
} from "./updater";

/**
 * Compact, non-blocking strip that surfaces a downloaded update.
 * - During download: nothing visible (the user shouldn't be interrupted).
 * - When ready: shows version + up to 4 release-note highlights, with
 *   "Install & restart" (immediate) and "Later" (defer to next quit).
 * - During install: a tiny "Updating…" line so the user knows why the panel
 *   is about to relaunch.
 */
export default function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus>({ phase: "idle" });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => subscribeUpdateStatus(setStatus), []);

  if (status.phase === "installing") {
    return (
      <div className="update-banner update-banner-compact">
        <span className="update-spinner" aria-hidden /> Updating Pluks…
      </div>
    );
  }

  if (status.phase !== "ready") return null;
  if (dismissed) return null;
  if (!shouldShowNoticeFor(status.version)) return null;

  const dismiss = () => {
    markUpdateNoticeDismissed(status.version);
    setDismissed(true);
  };

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <div className="update-banner-head">
        <span className="update-banner-title">
          Pluks {status.version} is ready
        </span>
        <button
          className="update-banner-dismiss"
          aria-label="Dismiss update notice"
          onClick={dismiss}
        >×</button>
      </div>

      {status.highlights.length > 0 && (
        <ul className="update-banner-notes">
          {status.highlights.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      )}

      <div className="update-banner-actions">
        <button
          className="update-banner-primary"
          onClick={() => { void installStagedUpdate(); }}
        >Install &amp; restart</button>
        <button
          className="update-banner-secondary"
          onClick={dismiss}
          title="We'll install automatically on your next quit"
        >Later</button>
      </div>
    </div>
  );
}
