import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import NudgeView from "./NudgeView";
import { ErrorBoundary, initAnalytics } from "./analytics";

// The same compiled bundle serves two Tauri windows:
//   - main app at index.html
//   - nudge overlay at index.html#nudge
// Routing by hash avoids a vite multi-page config; analytics + the
// error boundary still wrap both surfaces because they're set up here.
const isNudgeWindow = typeof window !== "undefined" && window.location.hash === "#nudge";

// Fire-and-forget — analytics must never block the UI from rendering.
// Skipped in the nudge window: it's a passive view that issues no events.
if (!isNudgeWindow) initAnalytics();
// Tag the body so the nudge stylesheet can clear the default opaque
// background that would otherwise defeat the window's transparency.
if (isNudgeWindow && typeof document !== "undefined") {
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
