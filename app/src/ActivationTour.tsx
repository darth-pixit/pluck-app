import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { track } from "./analytics";

/**
 * Post-permission activation tour. Runs once after the user grants AX +
 * Input Monitoring; exists to get them through the actual product loop
 * (select → copied → paste → repeat → ⌘⇧V) before they're left alone
 * with an empty panel. Each step gates on a real gesture, not just a
 * Next click — that's the whole point.
 */

const SHORTCUT_HINT = navigator.userAgent.includes("Mac") ? "⌘⇧V" : "Ctrl+Shift+V";

const SAMPLE_1 = "Pluks just copied this sentence the moment you highlighted it.";
const SAMPLE_2 = "Highlight me too — I'll stack on top of the first one.";

type StepKind = "select-1" | "paste" | "select-2" | "hold-to-paste" | "shortcut";
const STEPS: StepKind[] = ["select-1", "paste", "select-2", "hold-to-paste", "shortcut"];

interface Props {
  onDone: (reason: "skipped" | "completed", stepsDone: number) => void;
}

const COPY: Record<StepKind, { title: string; body: string; success: string; nextLabel: string }> = {
  "select-1": {
    title: "Try it — select the text below",
    body: "Drag across a few words. No Cmd+C, no right-click. Pluks grabs it the second you let go.",
    success: "✦ Copied. It's already on your clipboard.",
    nextLabel: "Next →",
  },
  paste: {
    title: "Now paste it here",
    body: "Cmd+V works exactly as it always has. Drop your selection into the box below.",
    success: "Boom. That's the whole loop.",
    nextLabel: "Next →",
  },
  "select-2": {
    title: "Stack another clip",
    body: "Each new selection lands on top of your history. The last 100 stay around.",
    success: "Two clips banked. You're getting it.",
    nextLabel: "Next →",
  },
  "hold-to-paste": {
    title: "Hold to paste — no Cmd+V either",
    body: "Anywhere on your Mac, press and hold for half a second. A wheel of your recent clips appears. Drag to one, let go — pasted.",
    success: "You'll feel it when you try it.",
    nextLabel: "Got it →",
  },
  shortcut: {
    title: `Open your stash with ${SHORTCUT_HINT}`,
    body: "Anywhere on your Mac. Search, click, paste — your last 100 clips, one shortcut away. Try it now.",
    success: "Welcome to Pluks.",
    nextLabel: "Get started →",
  },
};

// Activation tour fires once. The flag survives reinstalls of the same
// version because settings.json is in app data dir; we deliberately use
// localStorage instead so a reinstall genuinely resets the tour for QA.
const ACTIVATION_KEY = "pluks.activation.v1.seen";

export function shouldShowActivationTour(): boolean {
  try { return !localStorage.getItem(ACTIVATION_KEY); } catch { return false; }
}

export function markActivationSeen() {
  try { localStorage.setItem(ACTIVATION_KEY, "1"); } catch { /* private mode / quota */ }
}

export default function ActivationTour({ onDone }: Props) {
  const [stepIdx, setStepIdx] = useState(0);
  const [hit, setHit] = useState<Record<StepKind, boolean>>({
    "select-1": false,
    paste: false,
    "select-2": false,
    "hold-to-paste": false,
    shortcut: false,
  });
  const sample1Ref = useRef<HTMLParagraphElement>(null);
  const sample2Ref = useRef<HTMLParagraphElement>(null);
  const stepRef = useRef<StepKind>(STEPS[0]);
  stepRef.current = STEPS[stepIdx];

  const step = STEPS[stepIdx];
  const isLast = stepIdx === STEPS.length - 1;

  useEffect(() => {
    track("activation_started", {});
  }, []);

  // Selection detection — used for steps select-1 and select-2.
  // `selectionchange` is the most reliable cross-browser signal; `mouseup`
  // alone misses keyboard-driven (Shift+arrow) selections. We poll the
  // current selection and check whether it lives inside the active step's
  // sample paragraph.
  useEffect(() => {
    function check() {
      const cur = stepRef.current;
      const targetRef = cur === "select-1" ? sample1Ref : cur === "select-2" ? sample2Ref : null;
      if (!targetRef || !targetRef.current) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = sel.toString().trim();
      if (text.length < 3) return;
      try {
        const range = sel.getRangeAt(0);
        if (!targetRef.current.contains(range.commonAncestorContainer)) return;
      } catch { return; }
      // Pluks's own auto-copy listener won't fire while the panel is
      // visible, so we write to the clipboard ourselves to keep the
      // "copied" promise true for step 2's paste.
      try { navigator.clipboard.writeText(text).catch(() => {}); } catch { /* ignore */ }
      setHit(prev => prev[cur] ? prev : { ...prev, [cur]: true });
    }
    document.addEventListener("selectionchange", check);
    return () => document.removeEventListener("selectionchange", check);
  }, []);

  // Cmd+Shift+V detection — the global shortcut emits keyboard-open when
  // the panel is already visible (it doesn't toggle off). We listen for
  // that event to know the user pressed it.
  useEffect(() => {
    const un = listen("keyboard-open", () => {
      if (stepRef.current === "shortcut") {
        setHit(prev => prev.shortcut ? prev : { ...prev, shortcut: true });
      }
    });
    return () => { un.then(fn => fn()); };
  }, []);

  // Hold-to-paste is the one step we can't gesture-gate inside the tour:
  // the radial requires the history panel to be closed, but closing it
  // tears down the tour. Treat it as an awareness step — auto-mark hit
  // as soon as we land on it so the user can advance after reading the
  // explanation. The in-product discovery nudge (`hold_discovery` in
  // nudges.ts) handles real-world reinforcement once they have clips banked.
  useEffect(() => {
    if (step !== "hold-to-paste") return;
    const t = setTimeout(() => {
      setHit(prev => prev["hold-to-paste"] ? prev : { ...prev, "hold-to-paste": true });
    }, 1200);
    return () => clearTimeout(t);
  }, [step]);

  // Brief celebration delay before auto-advancing each step, so the
  // success message is actually readable.
  useEffect(() => {
    if (!hit[step]) return;
    const t = setTimeout(() => {
      track("activation_step_advanced", { step });
      if (isLast) {
        markActivationSeen();
        track("activation_completed", { dismiss_reason: "completed", steps_done: STEPS.length });
        onDone("completed", STEPS.length);
      } else {
        setStepIdx(i => i + 1);
      }
    }, 950);
    return () => clearTimeout(t);
  }, [hit, step, isLast, onDone]);

  // Manual advance (Next button) when the gesture has been hit but the
  // user clicks before the auto-advance fires. Works the same way.
  function advance() {
    if (!hit[step]) return;
    track("activation_step_advanced", { step });
    if (isLast) {
      markActivationSeen();
      track("activation_completed", { dismiss_reason: "completed", steps_done: STEPS.length });
      onDone("completed", STEPS.length);
    } else {
      setStepIdx(i => i + 1);
    }
  }

  function skip() {
    markActivationSeen();
    track("activation_completed", { dismiss_reason: "skipped", steps_done: stepIdx });
    onDone("skipped", stepIdx);
  }

  const copy = COPY[step];
  const stepDone = hit[step];

  return (
    <div className="tour-overlay" role="dialog" aria-modal="true" aria-label="Pluks activation">
      <div className="tour-card activation-card">
        <div className="tour-progress">
          {STEPS.map((_, i) => {
            const cls = i === stepIdx ? "active" : i < stepIdx ? "done" : "";
            return <span key={i} className={`tour-dot ${cls}`} />;
          })}
        </div>
        <h2 className="tour-title">{copy.title}</h2>
        <p className="tour-body">{copy.body}</p>

        {step === "select-1" && (
          <p
            ref={sample1Ref}
            className={`activation-sample ${hit["select-1"] ? "done" : ""}`}
          >
            {SAMPLE_1}
          </p>
        )}
        {step === "paste" && (
          <textarea
            className={`activation-paste ${hit.paste ? "done" : ""}`}
            placeholder="Paste here (Cmd+V) …"
            onPaste={() => setHit(prev => prev.paste ? prev : { ...prev, paste: true })}
            autoFocus
          />
        )}
        {step === "select-2" && (
          <p
            ref={sample2Ref}
            className={`activation-sample ${hit["select-2"] ? "done" : ""}`}
          >
            {SAMPLE_2}
          </p>
        )}
        {step === "hold-to-paste" && (
          <HoldDemo done={hit["hold-to-paste"]} />
        )}
        {step === "shortcut" && (
          <div className={`activation-shortcut ${hit.shortcut ? "done" : ""}`}>
            <kbd>{SHORTCUT_HINT}</kbd>
            <span className="activation-shortcut-hint">press it now</span>
          </div>
        )}

        <div className={`activation-status ${stepDone ? "show" : ""}`}>
          {stepDone ? copy.success : ""}
        </div>

        <div className="tour-actions">
          <button className="tour-skip" onClick={skip}>Skip</button>
          <button
            className="tour-next"
            onClick={advance}
            disabled={!stepDone}
            aria-disabled={!stepDone}
          >
            {copy.nextLabel}
          </button>
        </div>

        <p className="tour-footnote">
          ✓ Password fields are skipped automatically — Pluks never captures
          what you type into a secure input.
        </p>
      </div>
    </div>
  );
}

/**
 * Static-ish radial diagram for the activation tour. Renders the same
 * 5-slice geometry the real radial uses (see RadialMenu.tsx and paste.rs)
 * so the user recognises the shape when they encounter it in product. The
 * CSS handles a gentle "press" pulse so it reads as a gesture, not a logo.
 */
function HoldDemo({ done }: { done: boolean }) {
  const SIZE = 160;
  const CENTER = SIZE / 2;
  const INNER = 24;
  const OUTER = 70;
  const SLICES = 5;
  const STEP = 360 / SLICES;
  const polar = (deg: number, r: number): [number, number] => {
    const rad = (deg * Math.PI) / 180;
    return [CENTER + r * Math.sin(rad), CENTER - r * Math.cos(rad)];
  };
  const path = (i: number): string => {
    const a0 = i * STEP - STEP / 2;
    const a1 = i * STEP + STEP / 2;
    const [ox0, oy0] = polar(a0, OUTER);
    const [ox1, oy1] = polar(a1, OUTER);
    const [ix0, iy0] = polar(a0, INNER);
    const [ix1, iy1] = polar(a1, INNER);
    return [
      `M ${ox0} ${oy0}`,
      `A ${OUTER} ${OUTER} 0 0 1 ${ox1} ${oy1}`,
      `L ${ix1} ${iy1}`,
      `A ${INNER} ${INNER} 0 0 0 ${ix0} ${iy0}`,
      "Z",
    ].join(" ");
  };

  return (
    <div className={`hold-demo ${done ? "done" : ""}`}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} aria-hidden="true">
        {Array.from({ length: SLICES }).map((_, i) => (
          <path
            key={i}
            d={path(i)}
            className={`hold-demo-slice ${i === 1 ? "highlight" : ""}`}
            style={{ animationDelay: `${i * 90}ms` }}
          />
        ))}
        <circle cx={CENTER} cy={CENTER} r={INNER - 3} className="hold-demo-hub" />
      </svg>
      <div className="hold-demo-caption">
        press <kbd>·</kbd> hold <kbd>·</kbd> release on a slice
      </div>
    </div>
  );
}
