import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import PasteConfirmPill from "./PasteConfirmPill";

/**
 * Renders inside the dedicated `nudge` Tauri window. Owns two surfaces:
 *
 *   - `.nudge-pill` — adaptive copy/paste affirmations and correctives
 *     (driven by the `nudge-show` event from `show_nudge_impl`).
 *   - `.paste-confirm-pill` — silent-paste acknowledgement with the
 *     ⌃⇧V discovery shortcut (driven by `paste-confirm` from `paste.rs`
 *     via `show_paste_confirm`).
 *
 * The window itself is transparent + click-through + non-activating, set
 * up Rust-side; this component just owns the DOM. A paste-confirm event
 * preempts any in-flight nudge (a deliberate user gesture should never
 * be upstaged by an ambient affirmation), and vice versa — modeling
 * both as a single discriminated state makes the mutual exclusion
 * structural rather than enforced by setter sequencing.
 */

interface NudgePayload {
  kind: "affirmation" | "corrective";
  text: string;
  durationMs?: number;
}

interface PasteConfirmPayload {
  x: number;
  y: number;
  char_count: number;
}

type Pill =
  | { kind: "nudge"; payload: NudgePayload }
  | { kind: "paste-confirm"; payload: PasteConfirmPayload };

// Must match NUDGE_LIFETIME_MS in lib.rs and the cumulative CSS keyframe
// duration on .nudge-pill. Bump all three together.
const NUDGE_DURATION_MS = 1100;
// Must match PASTE_CONFIRM_LIFETIME_MS in lib.rs and the cumulative CSS
// keyframe duration on .paste-confirm-pill.
const PASTE_CONFIRM_DURATION_MS = 2350;

// `tauri dev` ⇒ true, bundled production build ⇒ false.
const DEV = import.meta.env.DEV;

function durationFor(pill: Pill): number {
  if (pill.kind === "paste-confirm") return PASTE_CONFIRM_DURATION_MS;
  return pill.payload.durationMs ?? NUDGE_DURATION_MS;
}

export default function NudgeView() {
  const [pill, setPill] = useState<Pill | null>(null);
  const [evtCount, setEvtCount] = useState(0);

  useEffect(() => {
    if (DEV) {
      // eslint-disable-next-line no-console
      console.log("[nudge-view] mounted hash=", JSON.stringify(window.location.hash));
    }
    const unNudge = listen<NudgePayload>("nudge-show", evt => {
      if (DEV) {
        // eslint-disable-next-line no-console
        console.log("[nudge-view] received nudge-show:", evt.payload);
      }
      setEvtCount(c => c + 1);
      setPill({ kind: "nudge", payload: evt.payload });
    });
    const unConfirm = listen<PasteConfirmPayload>("paste-confirm", evt => {
      if (DEV) {
        // eslint-disable-next-line no-console
        console.log("[nudge-view] received paste-confirm:", evt.payload);
      }
      setEvtCount(c => c + 1);
      setPill({ kind: "paste-confirm", payload: evt.payload });
    });
    return () => {
      unNudge.then(fn => fn());
      unConfirm.then(fn => fn());
    };
  }, []);

  // Auto-fade after the kind-specific duration. Re-fired on every new
  // payload, so back-to-back pills don't visually concatenate.
  useEffect(() => {
    if (!pill) return;
    const t = setTimeout(() => setPill(null), durationFor(pill));
    return () => clearTimeout(t);
  }, [pill]);

  // DEV-only visibility probe. Always renders — independent of pill
  // state. If you can see this red dot but not the pill, the React
  // tree is mounting and the window is rendering; the bug is in the
  // CSS / animation / opacity path. If you can't see this either,
  // the window itself isn't being composited.
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

  if (!pill) {
    return (
      <>
        {devProbe}
        <div className="nudge-root nudge-hidden" aria-hidden="true" />
      </>
    );
  }

  if (pill.kind === "paste-confirm") {
    return (
      <>
        {devProbe}
        <div className="nudge-root" aria-hidden="true">
          <PasteConfirmPill />
        </div>
      </>
    );
  }

  return (
    <>
      {devProbe}
      <div className={`nudge-root nudge-${pill.payload.kind}`} aria-hidden="true">
        <span className="nudge-pill">{pill.payload.text}</span>
      </div>
    </>
  );
}
