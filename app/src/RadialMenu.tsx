import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { diagLog } from "./analytics";
import { detect } from "./detectors";

/**
 * Renders inside the dedicated `radial` Tauri window. Pure visual surface —
 * all input (cursor angle, click, release) is driven by the global event tap
 * in `paste.rs`, which emits `radial-show` / `radial-highlight` / `radial-hide`
 * over Tauri's event bus. The window itself is click-through (configured
 * Rust-side); we never need pointer events here.
 */

interface RadialItem {
  id: number;
  content: string;
  copied_at: string;
  char_count: number;
}

interface ShowPayload {
  items: RadialItem[];
  center: { x: number; y: number };
}

interface HighlightPayload {
  index: number;
  inside: boolean;
}

// SVG geometry. Keep in sync with `RADIAL_SIZE`, `DEAD_ZONE_PX`,
// `OUTER_RADIUS_PX`, and `SLICE_COUNT` in `paste.rs` — both sides need the
// same numbers or the user's cursor and our rendered slice will disagree.
const SIZE = 260;
const CENTER = SIZE / 2;
const INNER_R = 36;
const OUTER_R = 120;
const SLICE_COUNT = 5;
const SLICE_DEG = 360 / SLICE_COUNT;

// Clockwise-from-north → screen-space (x, y). Screen Y grows downward,
// so "up" (0°) is (cx, cy - r), and angle increases toward the right.
function polar(angleDeg: number, r: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [CENTER + r * Math.sin(rad), CENTER - r * Math.cos(rad)];
}

// Donut-segment path for slice i (0 = top, indices grow clockwise).
function slicePath(i: number): string {
  const a0 = i * SLICE_DEG - SLICE_DEG / 2;
  const a1 = i * SLICE_DEG + SLICE_DEG / 2;
  const [ox0, oy0] = polar(a0, OUTER_R);
  const [ox1, oy1] = polar(a1, OUTER_R);
  const [ix0, iy0] = polar(a0, INNER_R);
  const [ix1, iy1] = polar(a1, INNER_R);
  // SVG arc flags: large-arc = 0 (each slice is <180°), sweep = 1 on outer
  // (clockwise from a0→a1 in screen space), sweep = 0 on inner (return).
  return [
    `M ${ox0} ${oy0}`,
    `A ${OUTER_R} ${OUTER_R} 0 0 1 ${ox1} ${oy1}`,
    `L ${ix1} ${iy1}`,
    `A ${INNER_R} ${INNER_R} 0 0 0 ${ix0} ${iy0}`,
    "Z",
  ].join(" ");
}

// Centroid of slice i at the middle of the donut for label placement.
function sliceCentroid(i: number): [number, number] {
  return polar(i * SLICE_DEG, (INNER_R + OUTER_R) / 2);
}

// Preview text inside a slice. We have ~80px of width and one line —
// short enough that any clip with more than a snippet must truncate.
function preview(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > 22 ? oneLine.slice(0, 21) + "…" : oneLine;
}

// `tauri dev` ⇒ true, bundled production build ⇒ false. Set by Vite at
// build time so this probe disappears from shipped releases.
const DEV = import.meta.env.DEV;

export default function RadialMenu() {
  const [items, setItems] = useState<RadialItem[]>([]);
  const [active, setActive] = useState<number>(-1);
  const [visible, setVisible] = useState(false);
  const [evtCount, setEvtCount] = useState(0);

  useEffect(() => {
    if (DEV) {
      // Forwarded to the `tauri dev` terminal via Rust `diag_log`. Webview
      // console.log only reaches this window's own DevTools, which is
      // impractical to open on a click-through transparent panel.
      diagLog(`[radial-menu] mounted hash=${JSON.stringify(window.location.hash)}`);
    }
    const unShow = listen<ShowPayload>("radial-show", evt => {
      if (DEV) {
        diagLog(`[radial-menu] received radial-show items=${evt.payload.items?.length}`);
      }
      setEvtCount(c => c + 1);
      setItems(evt.payload.items.slice(0, SLICE_COUNT));
      setActive(-1);
      setVisible(true);
    });
    const unHigh = listen<HighlightPayload>("radial-highlight", evt => {
      setActive(evt.payload.inside ? evt.payload.index : -1);
    });
    const unHide = listen("radial-hide", () => {
      if (DEV) {
        diagLog("[radial-menu] received radial-hide");
      }
      setVisible(false);
      setActive(-1);
    });
    if (DEV) {
      // Confirm each listen() actually registered. Distinguishes "listener
      // never attached" from "attached but no event arrived".
      unShow.then(() => diagLog("[radial-menu] listen(radial-show) registered"))
        .catch(e => diagLog(`[radial-menu] listen(radial-show) FAILED: ${String(e)}`));
      unHigh.then(() => diagLog("[radial-menu] listen(radial-highlight) registered"))
        .catch(e => diagLog(`[radial-menu] listen(radial-highlight) FAILED: ${String(e)}`));
      unHide.then(() => diagLog("[radial-menu] listen(radial-hide) registered"))
        .catch(e => diagLog(`[radial-menu] listen(radial-hide) FAILED: ${String(e)}`));
    }
    return () => {
      unShow.then(fn => fn());
      unHigh.then(fn => fn());
      unHide.then(fn => fn());
    };
  }, []);

  // DEV-only visibility probe. Always renders — independent of state.
  // If you can see this red dot but not the radial SVG, the React tree
  // is mounting and the window is rendering; the bug is in the
  // event-driven `visible`/`items` state path. If you can't see this
  // either, the window itself isn't being composited (or the webview
  // is dead).
  const devProbe = DEV ? (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: 16,
        height: 16,
        background: "lime",
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
          color: "magenta",
          whiteSpace: "nowrap",
          textShadow: "0 0 2px black",
        }}
      >
        r{evtCount}
      </span>
    </div>
  ) : null;

  if (!visible || items.length === 0) {
    return (
      <>
        {devProbe}
        <div className="radial-root radial-hidden" aria-hidden="true" />
      </>
    );
  }

  return (
    <>
      {devProbe}
      <div className="radial-root" aria-hidden="true">
      <svg
        className="radial-svg"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width={SIZE}
        height={SIZE}
      >
        {/* Slice fills + outlines */}
        {items.map((_, i) => (
          <path
            key={`slice-${i}`}
            d={slicePath(i)}
            className={`radial-slice ${active === i ? "active" : ""}`}
          />
        ))}

        {/* Dead-zone hub — visual cue that releasing in the centre cancels. */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={INNER_R - 2}
          className={`radial-hub ${active < 0 ? "active" : ""}`}
        />

        {/* Slice labels — badge + truncated preview, centred on each slice. */}
        {items.map((item, i) => {
          const [tx, ty] = sliceCentroid(i);
          const det = detect(item.content);
          const isActive = active === i;
          return (
            <g
              key={`label-${i}`}
              className={`radial-label ${isActive ? "active" : ""}`}
              transform={`translate(${tx} ${ty})`}
            >
              {det?.badge && (
                <text className="radial-badge" textAnchor="middle" y={-7}>
                  {det.badge}
                </text>
              )}
              <text className="radial-text" textAnchor="middle" y={det?.badge ? 9 : 4}>
                {preview(item.content)}
              </text>
            </g>
          );
        })}
      </svg>
      </div>
    </>
  );
}
