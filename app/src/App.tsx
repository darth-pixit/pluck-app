import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import HistoryPanel from "./HistoryPanel";
import PreferencesScreen from "./PreferencesScreen";
import { bucket, safeInvoke, track } from "./analytics";
import { detect } from "./detectors";
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
            <button className="step-btn" onClick={() => {
              track("permission_grant_clicked", { permission: "accessibility" });
              invoke("open_accessibility_settings");
              setTimeout(onCheck, 3000);
            }}>Grant →</button>
          )}
        </div>
        <div className={`setup-step ${hasInputMonitoring ? "done" : "pending"}`}>
          <div className="step-icon">{hasInputMonitoring ? "✓" : "2"}</div>
          <div className="step-body">
            <div className="step-title">Input Monitoring</div>
            <div className="step-desc">Lets Pluks detect when you select text with your mouse.</div>
          </div>
          {!hasInputMonitoring && (
            <button className="step-btn" onClick={() => {
              track("permission_grant_clicked", { permission: "input_monitoring" });
              invoke("open_input_monitoring_settings");
              setTimeout(onCheck, 3000);
            }}>Grant →</button>
          )}
        </div>
      </div>
      <p className="setup-hint">After granting each permission, come back here — this screen updates automatically.</p>
      <p className="setup-privacy-note">
        Pluks sends anonymous usage stats and crash reports to help us improve.
        Manage in <strong>⚙ Preferences</strong> after setup.
      </p>
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
  const [prefsOpen, setPrefsOpen]                   = useState(false);
  // When true: opened via CMD+Shift+V; releasing CMD auto-pastes the active item.
  const [keyboardMode, setKeyboardMode]             = useState(false);
  const keyboardModeTime                            = useRef(0);
  const lastShownAt                                 = useRef(0);
  const activeItemIdRef                             = useRef<number | null>(null);
  const pollRef                                     = useRef<ReturnType<typeof setInterval> | null>(null);
  const searchRef                                   = useRef<HTMLInputElement>(null);
  const prevPermsRef                                = useRef({ ax: false, im: false });
  const firstSeenRef                                = useRef<number>(Date.now());
  const searchDebounceRef                           = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkPermissions = useCallback(() => {
    invoke<boolean>("check_accessibility").then(v => {
      setHasAccessibility(v);
      if (v && !prevPermsRef.current.ax) {
        track("permission_granted", {
          permission: "accessibility",
          seconds_since_first_seen: Math.round((Date.now() - firstSeenRef.current) / 1000)
        });
      }
      prevPermsRef.current.ax = v;
    }).catch(() => setHasAccessibility(false));
    invoke<boolean>("check_input_monitoring").then(v => {
      setHasInputMonitoring(v);
      if (v && !prevPermsRef.current.im) {
        track("permission_granted", {
          permission: "input_monitoring",
          seconds_since_first_seen: Math.round((Date.now() - firstSeenRef.current) / 1000)
        });
      }
      prevPermsRef.current.im = v;
    }).catch(() => setHasInputMonitoring(false));
  }, []);

  const needsSetup = !hasAccessibility || !hasInputMonitoring;

  useEffect(() => {
    const t0 = performance.now();
    safeInvoke<HistoryItem[]>("get_history").then(rows => {
      setItems(rows);
      track("history_loaded", {
        item_count: rows.length,
        load_ms: Math.round(performance.now() - t0)
      });
    }).catch(console.error);
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
        track("panel_opened", { trigger: "focus_change", had_focus_target: true });
        checkPermissions();
        searchRef.current?.focus();
      } else if (!needsSetup) {
        if (Date.now() - lastShownAt.current < BLUR_HIDE_GRACE_MS) return;
        track("panel_closed", {
          dismiss_reason: "blur",
          open_duration_ms: Math.max(0, Date.now() - lastShownAt.current)
        });
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
      track("panel_opened", { trigger: "shortcut", had_focus_target: true });
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
        const item = items.find(i => i.id === id);
        if (item) {
          const det = detect(item.content);
          track("history_item_pasted_keyboard", {
            position: items.findIndex(i => i.id === id),
            kind: det?.kind || "unknown"
          });
        }
        await safeInvoke("copy_item", { id });
        await hideWindow();
        await new Promise(r => setTimeout(r, PASTE_FOCUS_RESTORE_MS));
        await safeInvoke("invoke_paste");
      }
    };
    window.addEventListener("keyup", handleKeyUp);
    return () => window.removeEventListener("keyup", handleKeyUp);
  }, [keyboardMode, items]);

  // Escape always dismisses the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        track("panel_closed", {
          dismiss_reason: "escape",
          open_duration_ms: Math.max(0, Date.now() - lastShownAt.current)
        });
        setKeyboardMode(false);
        hideWindow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Refocus the search field whenever the panel transitions into the main view.
  useEffect(() => {
    if (!needsSetup) searchRef.current?.focus();
  }, [needsSetup]);

  // Push something onto the clipboard, hide the panel, wait for macOS to
  // restore focus to the previously-foreground app, then synthesize Cmd+V.
  const pasteVia = useCallback(async (cmd: string, args: Record<string, unknown>) => {
    setKeyboardMode(false);
    await safeInvoke(cmd, args);
    await hideWindow();
    await new Promise(r => setTimeout(r, PASTE_FOCUS_RESTORE_MS));
    await safeInvoke("invoke_paste");
  }, []);

  const handleCopy = useCallback((id: number) => {
    const item = items.find(i => i.id === id);
    if (item) {
      const det = detect(item.content);
      track("history_item_clicked", {
        position: items.findIndex(i => i.id === id),
        kind: det?.kind || "unknown",
        char_count_bucket: bucket(item.char_count)
      });
    }
    return pasteVia("copy_item", { id });
  }, [items, pasteVia]);

  const handleCopyTransformed = useCallback((text: string, action_label: string, kind: string) => {
    track("smart_paste_used", { kind, action_label });
    return pasteVia("copy_text", { text });
  }, [pasteVia]);

  const handleDelete = useCallback(async (id: number, via: "keyboard" | "click") => {
    track("history_item_deleted", { position: items.findIndex(i => i.id === id), via });
    const ok = await safeInvoke<boolean>("delete_item", { id });
    if (ok) setItems(prev => prev.filter(i => i.id !== id));
  }, [items]);

  const handleClear = useCallback(async () => {
    track("history_cleared", { item_count_before: items.length });
    const ok = await safeInvoke<boolean>("clear_history");
    if (ok) setItems([]);
  }, [items.length]);

  // Debounced search-event emission. UI filters synchronously below.
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!query.trim()) return;
    searchDebounceRef.current = setTimeout(() => {
      const q = query.trim().toLowerCase();
      const result_count = items.filter(i => i.content.toLowerCase().includes(q)).length;
      track("history_searched", { query_length_bucket: bucket(q.length), result_count });
    }, 500);
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); };
  }, [query, items]);

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

  if (prefsOpen) {
    return (
      <div className="panel">
        <div className="titlebar" data-tauri-drag-region>
          <div className="traffic-lights">
            <button className="tl tl-close" title="Hide" onMouseDown={e => { e.preventDefault(); e.stopPropagation(); hideWindow(); }} />
          </div>
          <span className="brand">pluks</span>
          <button className="gear-btn active" title="Close preferences" onClick={() => setPrefsOpen(false)}>←</button>
        </div>
        <PreferencesScreen onClose={() => setPrefsOpen(false)} />
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
        <button
          className="gear-btn"
          title="Preferences"
          onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
          onClick={() => setPrefsOpen(true)}
        >⚙</button>
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
          onCopyTransformed={handleCopyTransformed}
          onNavigate={(direction, from, to) => track("history_navigated_keyboard", { direction, from_index: from, to_index: to })}
        />
      )}

      <div className="panel-footer">
        <button className="btn-clear" onClick={handleClear}>Clear all</button>
        <span className="hint">↑↓ navigate · ↩ copy · ⌫ delete · esc close</span>
      </div>
    </div>
  );
}
