import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary, initAnalytics } from "./analytics";

// Fire-and-forget — analytics must never block the UI from rendering.
initAnalytics();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary fallback={<CrashScreen />}>
      <App />
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
