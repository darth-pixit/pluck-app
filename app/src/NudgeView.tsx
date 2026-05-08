import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * Renders inside the dedicated `nudge` Tauri window. Listens for
 * `nudge-show` events from the main App's invoke calls, swaps text
 * accordingly, and triggers a CSS fade-in/-out.
 *
 * The window itself is configured transparent + click-through + non-
 * activating in Rust; this component just owns the DOM.
 */

interface ShowPayload {
  kind: "affirmation" | "corrective";
  text: string;
  durationMs?: number;
}

// Must match NUDGE_LIFETIME_MS in lib.rs and the cumulative CSS keyframe
// duration in index.css (.nudge-pill animation). Single source of truth
// for these three timelines lives nowhere — bump all three together.
const DEFAULT_DURATION_MS = 1100;

export default function NudgeView() {
  const [shown, setShown] = useState<ShowPayload | null>(null);

  useEffect(() => {
    const un = listen<ShowPayload>("nudge-show", evt => {
      setShown(evt.payload);
    });
    return () => { un.then(fn => fn()); };
  }, []);

  // Auto-fade after the configured duration. Re-fired on every new
  // payload, so back-to-back nudges don't visually concatenate.
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), shown.durationMs ?? DEFAULT_DURATION_MS);
    return () => clearTimeout(t);
  }, [shown]);

  if (!shown) {
    return <div className="nudge-root nudge-hidden" aria-hidden="true" />;
  }

  return (
    <div className={`nudge-root nudge-${shown.kind}`} aria-hidden="true">
      <span className="nudge-pill">{shown.text}</span>
    </div>
  );
}
