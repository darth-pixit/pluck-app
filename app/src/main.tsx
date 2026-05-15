import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import NudgeView from "./NudgeView";
import { ErrorBoundary, initAnalytics } from "./analytics";

// The same compiled bundle serves two Tauri windows:
//   - main app at index.html
//   - nudge overlay at index.html#nudge
// Routing by hash avoids a vite multi-page config; analytics + the
// error boundary still wrap all surfaces because they're set up here.
const hash = typeof window !== "undefined" ? window.location.hash : "";
const isNudgeWindow = hash === "#nudge";
const isOverlay = isNudgeWindow;

// DEV-only diagnostic: surface which window this bundle is mounting in.
// If the v0.4.5 logs show `show_nudge: emit(nudge-show) ok` but the nudge
// is invisible, the most likely cause is hash routing landing the wrong
// component in the nudge window (App.tsx mounts → no nudge-show listener
// → state never flips → transparent window with no opaque content).
// This log makes the actual hash visible per window so we can rule that in
// or out without inspecting devtools.
if (import.meta.env.DEV) {
  // eslint-disable-next-line no-console
  console.log(
    "[main.tsx] mounting hash=",
    JSON.stringify(hash),
    "isNudge=", isNudgeWindow,
    "isOverlay=", isOverlay,
  );
}

// Fire-and-forget — analytics must never block the UI from rendering.
// Skipped in overlay windows: those are passive views that issue no events.
if (!isOverlay) initAnalytics();
// Tag the body on the nudge window so its stylesheet can clear the
// default opaque background that would otherwise defeat transparency.
if (typeof document !== "undefined" && isNudgeWindow) {
  document.body.classList.add("nudge-body");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary fallback={<CrashScreen />}>
      {isNudgeWindow ? <NudgeView /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
);

function CrashScreen() {
  return (
    <div className="panel">
      <div className="setup-screen">
        <div className="setup-logo">pluks</div>
        <p className="setup-intro">
          Something broke. The error has been reported anonymously — sorry about that.
        </p>
        <p className="setup-hint">Try quitting Pluks from the tray and reopening it.</p>
      </div>
    </div>
  );
}
