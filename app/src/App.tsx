import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import HistoryPanel from "./HistoryPanel";
import "./index.css";

export interface HistoryItem {
  id: number;
  content: string;
  copied_at: string;
  char_count: number;
}

// ── Permission onboarding ──────────────────────────────────────────────────────

function SetupScreen({
  hasAccessibility,
  hasInputMonitoring,
  onCheck,
}: {
  hasAccessibility: boolean;
  hasInputMonitoring: boolean;
  onCheck: () => void;
}) {
  return (
    <div className="setup-screen">
      <div className="setup-logo">pluks</div>
      <p className="setup-intro">
        Two quick permissions to get you set up — these only need to be done
        once.
      </p>

      <div className="setup-steps">
        {/* Step 1 — Accessibility */}
        <div className={`setup-step ${hasAccessibility ? "done" : "pending"}`}>
          <div className="step-icon">{hasAccessibility ? "✓" : "1"}</div>
          <div className="step-body">
            <div className="step-title">Accessibility</div>
            <div className="step-desc">
              Lets Pluks simulate Cmd+C to copy your selection.
            </div>
          </div>
          {!hasAccessibility && (
            <button
              className="step-btn"
              onClick={() => {
                invoke("open_accessibility_settings");
                setTimeout(onCheck, 3000);
              }}
            >
              Grant →
            </button>
          )}
        </div>

        {/* Step 2 — Input Monitoring */}
        <div
          className={`setup-step ${hasInputMonitoring ? "done" : "pending"}`}
        >
          <div className="step-icon">{hasInputMonitoring ? "✓" : "2"}</div>
          <div className="step-body">
            <div className="step-title">Input Monitoring</div>
            <div className="step-desc">
              Lets Pluks detect when you select text with your mouse.
            </div>
          </div>
          {!hasInputMonitoring && (
            <button
              className="step-btn"
              onClick={() => {
                invoke("open_input_monitoring_settings");
                setTimeout(onCheck, 3000);
              }}
            >
              Grant →
            </button>
          )}
        </div>
      </div>

      <p className="setup-hint">
        After granting each permission, come back here — this screen updates
        automatically.
      </p>
    </div>
  );
}

// ── Main app ───────────────────────────────────────────────────────────────────

export default function App() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [hasAccessibility, setHasAccessibility] = useState(true);
  const [hasInputMonitoring, setHasInputMonitoring] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkPermissions = useCallback(() => {
    invoke<boolean>("check_accessibility")
      .then(setHasAccessibility)
      .catch(() => setHasAccessibility(true));
    invoke<boolean>("check_input_monitoring")
      .then(setHasInputMonitoring)
      .catch(() => setHasInputMonitoring(true));
  }, []);

  const needsSetup = !hasAccessibility || !hasInputMonitoring;

  // Initial load
  useEffect(() => {
    invoke<HistoryItem[]>("get_history").then(setItems).catch(console.error);
    checkPermissions();
  }, [checkPermissions]);

  // Poll every 2 s while setup screen is showing
  useEffect(() => {
    if (needsSetup) {
      pollRef.current = setInterval(checkPermissions, 2000);
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [needsSetup, checkPermissions]);

  // Re-check when window gains focus (user may have just granted a permission)
  useEffect(() => {
    const win = getCurrentWindow();
    let cleanup: (() => void) | undefined;
    win
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          checkPermissions();
        } else {
          win.hide();
        }
      })
      .then((fn) => (cleanup = fn));
    return () => cleanup?.();
  }, [checkPermissions]);

  // Listen for new selections
  useEffect(() => {
    const unlisten = listen<HistoryItem>("new-selection", (event) => {
      setItems((prev) => {
        if (prev[0]?.id === event.payload.id) return prev;
        return [event.payload, ...prev].slice(0, 100);
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Escape closes the panel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") getCurrentWindow().hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleCopy = useCallback(async (id: number) => {
    await invoke("copy_item", { id });
    getCurrentWindow().hide();
  }, []);

  const handleDelete = useCallback(async (id: number) => {
    await invoke("delete_item", { id });
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const handleClear = useCallback(async () => {
    await invoke("clear_history");
    setItems([]);
  }, []);

  const filtered = query.trim()
    ? items.filter((i) =>
        i.content.toLowerCase().includes(query.toLowerCase())
      )
    : items;

  // ── Render ────────────────────────────────────────────────────────────────

  if (needsSetup) {
    return (
      <div className="panel">
        <div className="titlebar">
          <div className="traffic-lights">
            <button
              className="tl tl-close"
              title="Close"
              onClick={() => getCurrentWindow().hide()}
            />
          </div>
          <span className="brand" data-tauri-drag-region>
            pluks
          </span>
        </div>
        <SetupScreen
          hasAccessibility={hasAccessibility}
          hasInputMonitoring={hasInputMonitoring}
          onCheck={checkPermissions}
        />
      </div>
    );
  }

  return (
    <div className="panel">
      {/* Title bar — drag region is only the brand text, not the buttons */}
      <div className="titlebar">
        <div className="traffic-lights">
          <button
            className="tl tl-close"
            title="Close"
            onClick={() => getCurrentWindow().hide()}
          />
          <button
            className="tl tl-min"
            title="Minimise"
            onClick={() => getCurrentWindow().minimize()}
          />
        </div>
        <span className="brand" data-tauri-drag-region>
          pluks
        </span>
        <span className="count" data-tauri-drag-region>{items.length} / 100</span>
      </div>

      <div className="search-row">
        <input
          autoFocus
          className="search"
          placeholder="Search history…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Let arrow keys and Enter navigate the list instead of moving cursor
            if (["ArrowUp", "ArrowDown", "Enter"].includes(e.key)) {
              e.preventDefault();
            }
          }}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          {query ? "No matches" : "Select any text to start collecting"}
        </div>
      ) : (
        <HistoryPanel
          items={filtered}
          onCopy={handleCopy}
          onDelete={handleDelete}
        />
      )}

      <div className="panel-footer">
        <button className="btn-clear" onClick={handleClear}>
          Clear all
        </button>
        <span className="hint">↑↓ navigate · ↩ copy · ⌫ delete · esc close</span>
      </div>
    </div>
  );
}
