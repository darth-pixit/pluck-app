import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * Renders inside the dedicated `nudge` Tauri window. Owns two surfaces:
 *
 *   - `.nudge-pill` — adaptive copy/paste affirmations and correctives
 *     (driven by the existing `nudge-show` event from `show_nudge_impl`).
 *   - `.paste-confirm-pill` — silent-paste acknowledgement with the
 *     ⌃⇧V discovery shortcut (driven by `paste-confirm` from `paste.rs`).
 *
 * The window itself is transparent + click-through + non-activating, set
 * up Rust-side; this component just owns the DOM.
 *
 * A paste-confirm event preempts any in-flight nudge: long-press paste
 * is a deliberate user gesture, so its acknowledgement should never be
 * upstaged by a stale affirmation that happens to overlap.
 */

interface ShowPayload {
  kind: "affirmation" | "corrective";
  text: string;
  durationMs?: number;
}

interface PasteConfirmPayload {
  x: number;
  y: number;
  char_count: number;
}

// Must match NUDGE_LIFETIME_MS in lib.rs and the cumulative CSS keyframe
// duration in index.css (.nudge-pill animation). Single source of truth
// for these three timelines lives nowhere — bump all three together.
const DEFAULT_DURATION_MS = 1100;
// Must match PASTE_CONFIRM_LIFETIME_MS in lib.rs and the cumulative CSS
// keyframe duration on .paste-confirm-pill. Same caveat as above.
const PASTE_CONFIRM_DURATION_MS = 2350;

// `tauri dev` ⇒ true, bundled production build ⇒ false. Set by Vite at
// build time so this probe disappears from shipped releases.
const DEV = import.meta.env.DEV;

export default function NudgeView() {
  const [shown, setShown] = useState<ShowPayload | null>(null);
  const [pasteConfirm, setPasteConfirm] = useState<PasteConfirmPayload | null>(null);
  const [evtCount, setEvtCount] = useState(0);

  useEffect(() => {
    if (DEV) {
      // Stream into the same terminal as `npm run tauri dev` so we can
      // verify (a) the React tree mounted in this window at all and
      // (b) what window.location.hash resolved to — if `main.tsx`'s
      // hash routing failed, App.tsx would mount here instead and we'd
      // never see this line for the nudge window specifically.
      // eslint-disable-next-line no-console
      console.log("[nudge-view] mounted hash=", JSON.stringify(window.location.hash));
    }
    const unNudge = listen<ShowPayload>("nudge-show", evt => {
      if (DEV) {
        // eslint-disable-next-line no-console
        console.log("[nudge-view] received nudge-show:", evt.payload);
      }
      setEvtCount(c => c + 1);
      // A fresh paste-confirm on screen takes precedence — the user
      // just made a deliberate gesture and we don't want to swap it
      // out from under them for an ambient affirmation.
      setPasteConfirm(null);
      setShown(evt.payload);
    });
    const unConfirm = listen<PasteConfirmPayload>("paste-confirm", evt => {
      if (DEV) {
        // eslint-disable-next-line no-console
        console.log("[nudge-view] received paste-confirm:", evt.payload);
      }
      setEvtCount(c => c + 1);
      setShown(null);
      setPasteConfirm(evt.payload);
    });
    return () => {
      unNudge.then(fn => fn());
      unConfirm.then(fn => fn());
    };
  }, []);

  // Auto-fade after the configured duration. Re-fired on every new
  // payload, so back-to-back nudges don't visually concatenate.
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), shown.durationMs ?? DEFAULT_DURATION_MS);
    return () => clearTimeout(t);
  }, [shown]);

  useEffect(() => {
    if (!pasteConfirm) return;
    const t = setTimeout(() => setPasteConfirm(null), PASTE_CONFIRM_DURATION_MS);
    return () => clearTimeout(t);
  }, [pasteConfirm]);

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

  if (pasteConfirm) {
    return (
      <>
        {devProbe}
        <div className="nudge-root" aria-hidden="true">
          <div className="paste-confirm-pill">
            <span className="paste-confirm-dot" />
            <span className="paste-confirm-lead">Pasted</span>
            <span className="paste-confirm-kbd">
              <span className="kc">⌃</span>
              <span className="kc">⇧</span>
              <span className="kc">V</span>
              <span className="paste-confirm-trail">more</span>
            </span>
          </div>
        </div>
      </>
    );
  }

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
