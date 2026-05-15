import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { diagLog } from "./analytics";

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

// `tauri dev` ⇒ true, bundled production build ⇒ false. Set by Vite at
// build time so this probe disappears from shipped releases.
const DEV = import.meta.env.DEV;

export default function NudgeView() {
  const [shown, setShown] = useState<ShowPayload | null>(null);
  const [evtCount, setEvtCount] = useState(0);

  useEffect(() => {
    if (DEV) {
      // Forwarded to the `tauri dev` terminal via the Rust `diag_log`
      // command (see analytics.diagLog). Webview console.log only reaches
      // this window's own DevTools, which we can't open on a click-through
      // transparent panel. If main.tsx's hash routing failed, App.tsx
      // would mount here instead and we'd never see this line.
      diagLog(`[nudge-view] mounted hash=${JSON.stringify(window.location.hash)}`);
    }
    const un = listen<ShowPayload>("nudge-show", evt => {
      if (DEV) {
        diagLog(`[nudge-view] received nudge-show kind=${evt.payload.kind}`);
      }
      setEvtCount(c => c + 1);
      setShown(evt.payload);
    });
    if (DEV) {
      // Confirm listen() actually registered (its returned promise resolves)
      // — answers the "did the listener attach at all?" question separately
      // from "did any event reach the listener?".
      un.then(() => diagLog("[nudge-view] listen(nudge-show) registered"))
        .catch(e => diagLog(`[nudge-view] listen(nudge-show) FAILED: ${String(e)}`));
    }
    return () => { un.then(fn => fn()); };
  }, []);

  // Auto-fade after the configured duration. Re-fired on every new
  // payload, so back-to-back nudges don't visually concatenate.
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), shown.durationMs ?? DEFAULT_DURATION_MS);
    return () => clearTimeout(t);
  }, [shown]);

  // DEV-only visibility probe. Always renders — independent of the
  // event-driven `shown` state. If you can see this red dot but not
  // the pill, the React tree is mounting and the window is rendering;
  // the bug is in the CSS / animation / opacity path that gates the
  // pill itself. If you can't see this either, the window itself
  // isn't being composited (or the webview is dead).
  const devProbe = DEV ? (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: 16,
        height: 16,
        background: "red",
        zIndex: 10000,
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 0,
          left: 18,
          fontSize: 9,
          color: "yellow",
          whiteSpace: "nowrap",
          textShadow: "0 0 2px black",
        }}
      >
        n{evtCount}
      </span>
    </div>
  ) : null;

  if (!shown) {
    return (
      <>
        {devProbe}
        <div className="nudge-root nudge-hidden" aria-hidden="true" />
      </>
    );
  }

  return (
    <>
      {devProbe}
      <div className={`nudge-root nudge-${shown.kind}`} aria-hidden="true">
        <span className="nudge-pill">{shown.text}</span>
      </div>
    </>
  );
}
