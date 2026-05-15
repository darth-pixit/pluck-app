import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import NudgeView from "./NudgeView";
import RadialMenu from "./RadialMenu";
import { ErrorBoundary, initAnalytics } from "./analytics";

// The same compiled bundle serves three Tauri windows:
//   - main app at index.html
//   - nudge overlay at index.html#nudge
//   - radial paste overlay at index.html#radial
// Routing by hash avoids a vite multi-page config; analytics + the
// error boundary still wrap all surfaces because they're set up here.
const hash = typeof window !== "undefined" ? window.location.hash : "";
const isNudgeWindow = hash === "#nudge";
const isRadialWindow = hash === "#radial";
const isOverlay = isNudgeWindow || isRadialWindow;

// Fire-and-forget — analytics must never block the UI from rendering.
// Skipped in overlay windows: those are passive views that issue no events.
if (!isOverlay) initAnalytics();
// Tag the body on overlay windows so their stylesheets can clear the
// default opaque background that would otherwise defeat transparency.
if (typeof document !== "undefined") {
  if (isNudgeWindow) document.body.classList.add("nudge-body");
  if (isRadialWindow) document.body.classList.add("radial-body");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary fallback={<CrashScreen />}>
      {isRadialWindow ? <RadialMenu /> : isNudgeWindow ? <NudgeView /> : <App />}
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
