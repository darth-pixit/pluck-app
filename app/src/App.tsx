import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import HistoryPanel from "./HistoryPanel";
import "./index.css";

const hideWindow    = () => invoke("hide_window").catch(() => getCurrentWindow().hide());
const minimizeWindow = () => invoke("minimize_window").catch(() => getCurrentWindow().minimize());

export interface HistoryItem {
  id: number;
  content: string;
  copied_at: string;
  char_count: number;
}

// ── Permission onboarding ──────────────────────────────────────────────────────

function SetupScreen({
  hasAccessibility, hasInputMonitoring, onCheck,
}: { hasAccessibility: boolean; hasInputMonitoring: boolean; onCheck: () => void }) {
  return (
    <div className="setup-screen">
      <div className="setup-logo">pluks</div>
      <p className="setup-intro">Two quick permissions to get you set up — these only need to be done once.</p>
      <div className="setup-steps">
        <div className={`setup-step ${hasAccessibility ? "done" : "pending"}`}>
          <div className="step-icon">{hasAccessibility ? "✓" : "1"}</div>
          <div className="step-body">
            <div className="step-title">Accessibility</div>
            <div className="step-desc">Lets Pluks simulate Cmd+C to copy your selection.</div>
          </div>
          {!hasAccessibility && (
            <button className="step-btn" onClick={() => { invoke("open_accessibility_settings"); setTimeout(onCheck, 3000); }}>Grant →</button>
          )}
        </div>
        <div className={`setup-step ${hasInputMonitoring ? "done" : "pending"}`}>
          <div className="step-icon">{hasInputMonitoring ? "✓" : "2"}</div>
          <div className="step-body">
            <div className="step-title">Input Monitoring</div>
            <div className="step-desc">Lets Pluks detect when you select text with your mouse.</div>
          </div>
          {!hasInputMonitoring && (
            <button className="step-btn" onClick={() => { invoke("open_input_monitoring_settings"); setTimeout(onCheck, 3000); }}>Grant →</button>
          )}
        </div>
      </div>
      <p className="setup-hint">After granting each permission, come back here — this screen updates automatically.</p>
    </div>
  );
}

// ── Main app ───────────────────────────────────────────────────────────────────

export default function App() {
  const [items, setItems]                           = useState<HistoryItem[]>([]);
  const [query, setQuery]                           = useState("");
  const [hasAccessibility, setHasAccessibility]     = useState(true);
  const [hasInputMonitoring, setHasInputMonitoring] = useState(true);
  // When true: opened via CMD+Shift+V; releasing CMD auto-pastes the active item.
  const [keyboardMode, setKeyboardMode]             = useState(false);
  const keyboardModeTime                            = useRef(0);
  const activeItemIdRef                             = useRef<number | null>(null);
  const pollRef                                     = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkPermissions = useCallback(() => {
    invoke<boolean>("check_accessibility").then(setHasAccessibility).catch(() => setHasAccessibility(true));
    invoke<boolean>("check_input_monitoring").then(setHasInputMonitoring).catch(() => setHasInputMonitoring(true));
  }, []);

  const needsSetup = !hasAccessibility || !hasInputMonitoring;

  useEffect(() => {
    invoke<HistoryItem[]>("get_history").then(setItems).catch(console.error);
    checkPermissions();
  }, [checkPermissions]);

  useEffect(() => {
    if (needsSetup) {
      pollRef.current = setInterval(checkPermissions, 2000);
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [needsSetup, checkPermissions]);

  // Re-check permissions + refresh history on focus; hide on blur
  useEffect(() => {
    const win = getCurrentWindow();
    let cleanup: (() => void) | undefined;
    win.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        checkPermissions();
        invoke<HistoryItem[]>("get_history").then(setItems).catch(console.error);
      } else if (!needsSetup) {
        setKeyboardMode(false);
        win.hide();
      }
    }).then(fn => (cleanup = fn));
    return () => cleanup?.();
  }, [checkPermissions, needsSetup]);

  // Receive new auto-captured items from the background watcher
  useEffect(() => {
    const unlisten = listen<HistoryItem>("new-selection", event => {
      setItems(prev => {
        if (prev[0]?.id === event.payload.id) return prev;
        return [event.payload, ...prev].slice(0, 100);
      });
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // Rust emits "keyboard-open" when CMD+Shift+V opens the panel
  useEffect(() => {
    const unlisten = listen("keyboard-open", () => {
      setKeyboardMode(true);
      keyboardModeTime.current = Date.now();
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // In keyboard mode, releasing CMD pastes the currently highlighted item
  useEffect(() => {
    if (!keyboardMode) return;
    const handleKeyUp = async (e: KeyboardEvent) => {
      if (e.key === "Meta") {
        // Ignore the key-up that fires <100 ms after opening (shortcut's own release)
        if (Date.now() - keyboardModeTime.current < 100) return;
        const id = activeItemIdRef.current;
        setKeyboardMode(false);
        if (id !== null) {
          await invoke("copy_item", { id });
          await hideWindow();
          // Give macOS ~150 ms to restore focus to the previous app, then paste
          await new Promise(r => setTimeout(r, 150));
          await invoke("invoke_paste");
        }
      }
    };
    window.addEventListener("keyup", handleKeyUp);
    return () => window.removeEventListener("keyup", handleKeyUp);
  }, [keyboardMode]);

  // Escape always dismisses the panel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setKeyboardMode(false); hideWindow(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleCopy = useCallback(async (id: number) => {
    setKeyboardMode(false);
    await invoke("copy_item", { id });
    hideWindow();
  }, []);

  const handleDelete = useCallback(async (id: number) => {
    await invoke("delete_item", { id });
    setItems(prev => prev.filter(i => i.id !== id));
  }, []);

  const handleClear = useCallback(async () => {
    await invoke("clear_history");
    setItems([]);
  }, []);

  const filtered = query.trim()
    ? items.filter(i => i.content.toLowerCase().includes(query.toLowerCase()))
    : items;

  if (needsSetup) {
    return (
      <div className="panel">
        <div className="titlebar">
          <div className="traffic-lights">
            <button className="tl tl-close" title="Close" onMouseDown={e => e.stopPropagation()} onClick={hideWindow} />
          </div>
          <span className="brand" data-tauri-drag-region>pluks</span>
        </div>
        <SetupScreen hasAccessibility={hasAccessibility} hasInputMonitoring={hasInputMonitoring} onCheck={checkPermissions} />
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="titlebar">
        <div className="traffic-lights">
          <button className="tl tl-close" title="Close"    onMouseDown={e => e.stopPropagation()} onClick={hideWindow} />
          <button className="tl tl-min"   title="Minimise" onMouseDown={e => e.stopPropagation()} onClick={minimizeWindow} />
        </div>
        <span className="brand" data-tauri-drag-region>pluks</span>
        <span className="count" data-tauri-drag-region>{items.length} / 100</span>
      </div>

      <div className="search-row">
        <input
          autoFocus
          className="search"
          placeholder="Search history…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (["ArrowUp","ArrowDown","Enter"].includes(e.key)) e.preventDefault(); }}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="empty">{query ? "No matches" : "Select any text to start collecting"}</div>
      ) : (
        <HistoryPanel
          items={filtered}
          onCopy={handleCopy}
          onDelete={handleDelete}
          onActiveChange={id => { activeItemIdRef.current = id; }}
        />
      )}

      <div className="panel-footer">
        <button className="btn-clear" onClick={handleClear}>Clear all</button>
        <span className="hint">↑↓ navigate · ↩ copy · ⌫ delete · esc close</span>
      </div>
    </div>
  );
}
