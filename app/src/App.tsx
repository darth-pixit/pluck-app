import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import HistoryPanel from "./HistoryPanel";
import "./index.css";

// Direct Tauri window API — never goes through Rust invoke, always reliable.
const hideWindow = () => getCurrentWindow().hide();

// 100 ms guard against the shortcut's own Cmd-release that fires right after the
// global shortcut activates the panel.
const KEYBOARD_OPEN_DEBOUNCE_MS = 100;

// macOS gives focus ~150–200 ms to return to the previous app after we hide.
const PASTE_FOCUS_RESTORE_MS = 200;

// Ignore blur events fired within this window after the panel opens — focus
// can flicker once during the show() → orderFront → makeKey sequence.
const BLUR_HIDE_GRACE_MS = 250;

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
  // Default to "not granted" so the setup screen shows until the first check
  // returns. An invoke failure also lands here, which is the safe default —
  // showing the main panel without permissions would hand the user a broken UI.
  const [hasAccessibility, setHasAccessibility]     = useState(false);
  const [hasInputMonitoring, setHasInputMonitoring] = useState(false);
  // When true: opened via CMD+Shift+V; releasing CMD auto-pastes the active item.
  const [keyboardMode, setKeyboardMode]             = useState(false);
  const keyboardModeTime                            = useRef(0);
  const lastShownAt                                 = useRef(0);
  const activeItemIdRef                             = useRef<number | null>(null);
  const pollRef                                     = useRef<ReturnType<typeof setInterval> | null>(null);
  const searchRef                                   = useRef<HTMLInputElement>(null);

  const checkPermissions = useCallback(() => {
    invoke<boolean>("check_accessibility").then(setHasAccessibility).catch(() => setHasAccessibility(false));
    invoke<boolean>("check_input_monitoring").then(setHasInputMonitoring).catch(() => setHasInputMonitoring(false));
  }, []);

  const needsSetup = !hasAccessibility || !hasInputMonitoring;

  useEffect(() => {
    invoke<HistoryItem[]>("get_history").then(setItems).catch(console.error);
    checkPermissions();
  }, [checkPermissions]);

  useEffect(() => {
    if (needsSetup) {
      pollRef.current = setInterval(checkPermissions, 2000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [needsSetup, checkPermissions]);

  // On focus: re-check permissions + refocus the search field, and stamp
  // the open time so the immediately-following blur (from focus flicker
  // during show → orderFront → makeKey) doesn't insta-hide the panel.
  // On blur (outside the grace window): hide — that's our click-outside-to-dismiss.
  useEffect(() => {
    const win = getCurrentWindow();
    let active = true;
    let cleanup: (() => void) | undefined;
    win.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        lastShownAt.current = Date.now();
        checkPermissions();
        searchRef.current?.focus();
      } else if (!needsSetup) {
        if (Date.now() - lastShownAt.current < BLUR_HIDE_GRACE_MS) return;
        setKeyboardMode(false);
        win.hide();
      }
    }).then(fn => { if (!active) fn(); else cleanup = fn; });
    return () => { active = false; cleanup?.(); };
  }, [checkPermissions, needsSetup]);

  // Cmd+Shift+Up / Cmd+Shift+Down arrive as Tauri events because macOS
  // swallows arrow keydowns at the OS level when Cmd is held. Replay them
  // as synthetic keydowns so HistoryPanel's existing arrow handling works.
  useEffect(() => {
    const unUp = listen("navigate-up", () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    const unDown = listen("navigate-down", () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    return () => { unUp.then(fn => fn()); unDown.then(fn => fn()); };
  }, []);

  // Receive new auto-captured items from the background watcher.
  useEffect(() => {
    const unlisten = listen<HistoryItem>("new-selection", event => {
      setItems(prev => {
        if (prev[0]?.id === event.payload.id) return prev;
        // Filter any prior occurrence so the same row never appears twice.
        const filtered = prev.filter(i => i.id !== event.payload.id);
        return [event.payload, ...filtered].slice(0, 100);
      });
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // Rust emits "keyboard-open" when CMD+Shift+V opens the panel.
  useEffect(() => {
    const unlisten = listen("keyboard-open", () => {
      setKeyboardMode(true);
      keyboardModeTime.current = Date.now();
      searchRef.current?.focus();
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // In keyboard mode, releasing CMD pastes the currently highlighted item.
  useEffect(() => {
    if (!keyboardMode) return;
    const handleKeyUp = async (e: KeyboardEvent) => {
      if (e.key !== "Meta") return;
      // Ignore the key-up that fires right after opening (the shortcut's own release).
      if (Date.now() - keyboardModeTime.current < KEYBOARD_OPEN_DEBOUNCE_MS) return;
      const id = activeItemIdRef.current;
      setKeyboardMode(false);
      if (id !== null) {
        await invoke("copy_item", { id });
        await hideWindow();
        await new Promise(r => setTimeout(r, PASTE_FOCUS_RESTORE_MS));
        await invoke("invoke_paste");
      }
    };
    window.addEventListener("keyup", handleKeyUp);
    return () => window.removeEventListener("keyup", handleKeyUp);
  }, [keyboardMode]);

  // Escape always dismisses the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setKeyboardMode(false); hideWindow(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Refocus the search field whenever the panel transitions into the main view.
  useEffect(() => {
    if (!needsSetup) searchRef.current?.focus();
  }, [needsSetup]);

  const handleCopy = useCallback(async (id: number) => {
    setKeyboardMode(false);
    await invoke("copy_item", { id });
    await hideWindow();
    // Wait for macOS to restore focus to whatever app was foreground before
    // the panel opened, then send Cmd+V there.
    await new Promise(r => setTimeout(r, PASTE_FOCUS_RESTORE_MS));
    await invoke("invoke_paste");
  }, []);

  const handleDelete = useCallback(async (id: number) => {
    const ok = await invoke<boolean>("delete_item", { id });
    if (ok) setItems(prev => prev.filter(i => i.id !== id));
  }, []);

  const handleClear = useCallback(async () => {
    const ok = await invoke<boolean>("clear_history");
    if (ok) setItems([]);
  }, []);

  const filtered = query.trim()
    ? items.filter(i => i.content.toLowerCase().includes(query.toLowerCase()))
    : items;

  if (needsSetup) {
    return (
      <div className="panel">
        <div className="titlebar" data-tauri-drag-region>
          <div className="traffic-lights">
            <button className="tl tl-close" title="Hide" onMouseDown={e => { e.preventDefault(); e.stopPropagation(); hideWindow(); }} />
          </div>
          <span className="brand">pluks</span>
        </div>
        <SetupScreen hasAccessibility={hasAccessibility} hasInputMonitoring={hasInputMonitoring} onCheck={checkPermissions} />
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="titlebar" data-tauri-drag-region>
        <div className="traffic-lights">
          <button className="tl tl-close" title="Hide" onMouseDown={e => { e.preventDefault(); e.stopPropagation(); hideWindow(); }} />
        </div>
        <span className="brand">pluks</span>
        <span className="count">{items.length} / 100</span>
      </div>

      <div className="search-row">
        <input
          ref={searchRef}
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
