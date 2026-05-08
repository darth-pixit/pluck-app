import { type MouseEvent as ReactMouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import HistoryPanel from "./HistoryPanel";
import PreferencesScreen from "./PreferencesScreen";
import UpdateBanner from "./UpdateBanner";
import ActivationTour, { shouldShowActivationTour } from "./ActivationTour";
import { startUpdater } from "./updater";
import { bucket, safeInvoke, track } from "./analytics";
import { decideAffirmation, decideCorrective, type NudgeDecision } from "./nudges";
import { detect } from "./detectors";
import "./index.css";

// Direct Tauri window API — never goes through Rust invoke, always reliable.
const hideWindow = () => getCurrentWindow().hide();
// macOS NSPanel may ignore minimize without the miniaturizable style bit;
// fall back to hide so the yellow button always does *something* useful.
const minimizeWindow = () =>
  getCurrentWindow().minimize().catch(() => getCurrentWindow().hide());

// Programmatic drag — more reliable than data-tauri-drag-region on NSPanel,
// especially when another app (e.g. System Settings during permission grants)
// is the foreground app and our window isn't yet key.
const startDrag = (e: ReactMouseEvent) => {
  if ((e.target as HTMLElement).closest("button,input,a")) return;
  if (e.button !== 0) return;
  getCurrentWindow().startDragging().catch(() => { /* dragging unsupported — fine */ });
};

// Standard macOS traffic-light cluster — close + minimize, per HIG.
// Zoom is omitted because the panel is fixed-size by design.
function TrafficLights() {
  return (
    <div className="traffic-lights">
      <button
        className="tl tl-close"
        title="Close"
        aria-label="Close"
        onMouseDown={e => { e.preventDefault(); e.stopPropagation(); hideWindow(); }}
      />
      <button
        className="tl tl-min"
        title="Minimize"
        aria-label="Minimize"
        onMouseDown={e => { e.preventDefault(); e.stopPropagation(); minimizeWindow(); }}
      />
    </div>
  );
}

function Titlebar({ children }: { children?: ReactNode }) {
  return (
    <div className="titlebar" data-tauri-drag-region onMouseDown={startDrag}>
      <TrafficLights />
      <span className="brand" data-tauri-drag-region>pluks</span>
      {children}
    </div>
  );
}

// Platform detection (synchronous, fine for static UI/keybinding choices).
// userAgentData.platform is the modern source; navigator.platform is the
// fallback that still works on every browser engine Tauri ships with.
const PLATFORM = (
  (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ||
  navigator.platform ||
  ""
).toLowerCase();
const IS_MAC = PLATFORM.includes("mac");
// On macOS the keyboard-mode trigger is Cmd (KeyboardEvent.key === "Meta").
// On Windows/Linux the global shortcut resolves to Ctrl, so the matching
// release key is "Control".
const RELEASE_KEY = IS_MAC ? "Meta" : "Control";
const SHORTCUT_HINT = IS_MAC ? "⌘⇧V" : "Ctrl+Shift+V";

if (typeof document !== "undefined") {
  document.body.classList.add(IS_MAC ? "platform-mac" : "platform-other");
}

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
      <p className="setup-intro">
        Two quick permissions to get you set up — these only need to be done once.
        You can drag this window by its title bar, or hide it and re-open from the menu-bar icon.
      </p>
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

// ── Post-permission onboarding tour ────────────────────────────────────────────

const ONBOARDING_KEY = "pluks.onboarding.v1.seen";

interface TourStep {
  title: string;
  body: string;
}

const TOUR_STEPS: TourStep[] = [
  {
    title: "Select to copy",
    body: "Highlight any text — anywhere on your Mac. No Cmd+C, no right-click. Pluks grabs it the moment you let go.",
  },
  {
    title: `Your last 100 clips, ${SHORTCUT_HINT} away`,
    body: "Hit the shortcut from any app to open your clipboard history. Search, click, paste — anything you copied recently is one tap away.",
  },
  {
    title: "Privacy first — local only",
    body: "What you copy stays on this Mac. Pluks doesn't read it, doesn't sync it, doesn't send it anywhere. Open source, on-device, full stop.",
  },
];

function OnboardingTour({ onDone }: { onDone: (reason: "skipped" | "completed") => void }) {
  const [step, setStep] = useState(0);
  const last = step === TOUR_STEPS.length - 1;
  const current = TOUR_STEPS[step];
  return (
    <div className="tour-overlay" role="dialog" aria-modal="true" aria-label="Pluks onboarding">
      <div className="tour-card">
        <div className="tour-progress">
          {TOUR_STEPS.map((_, i) => {
            const cls = i === step ? "active" : i < step ? "done" : "";
            return <span key={i} className={`tour-dot ${cls}`} />;
          })}
        </div>
        <h2 className="tour-title">{current.title}</h2>
        <p className="tour-body">{current.body}</p>
        <div className="tour-actions">
          <button className="tour-skip" onClick={() => onDone("skipped")}>Skip</button>
          <button
            className="tour-next"
            onClick={() => {
              track("onboarding_step_advanced", { step });
              if (last) onDone("completed");
              else setStep(s => s + 1);
            }}
          >
            {last ? "Get started" : "Next →"}
          </button>
        </div>
      </div>
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
  // Onboarding tour shows before the permission setup screen on a fresh
  // install — the user benefits from understanding what they're granting
  // permissions for before being prompted. Initialised lazily from
  // localStorage so first-run users land on the tour, not the perms screen.
  const [showTour, setShowTour]                     = useState(() => {
    let seen = true;
    try { seen = !!localStorage.getItem(ONBOARDING_KEY); } catch { /* private mode */ }
    if (!seen) track("onboarding_started", {});
    return !seen;
  });
  // Activation tour shows once after permissions land, before the user
  // hits the empty main panel. Initialised lazily, but the show/hide
  // transition is driven by an effect that watches needsSetup → false.
  const [showActivation, setShowActivation]         = useState(false);
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
    // Start the background updater. Internal startup delay + idempotent so
    // it's safe under StrictMode and doesn't compete with permission prompts.
    startUpdater();
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

  // Drop always-on-top while the permission setup screen is showing so the
  // panel doesn't float over System Settings during grants; restore once
  // setup is done. Tour-in-progress doesn't open System Settings, so it
  // stays always-on-top. The ref guards against redundant IPC calls — Rust
  // already configures alwaysOnTop=true at startup, so a no-op transition
  // would otherwise round-trip on every mount and on every needsSetup flip.
  const lastAlwaysOnTopRef = useRef<boolean | null>(null);
  useEffect(() => {
    const wantOnTop = !(needsSetup && !showTour);
    if (lastAlwaysOnTopRef.current === wantOnTop) return;
    lastAlwaysOnTopRef.current = wantOnTop;
    getCurrentWindow().setAlwaysOnTop(wantOnTop).catch(console.warn);
  }, [needsSetup, showTour]);

  const dismissTour = useCallback((reason: "skipped" | "completed") => {
    try { localStorage.setItem(ONBOARDING_KEY, "1"); } catch { /* private mode / quota */ }
    track("onboarding_completed", { dismiss_reason: reason });
    setShowTour(false);
  }, []);

  // Surface the activation tour exactly once: only after the welcome tour
  // is past, permissions have landed, and the user hasn't seen activation
  // before. The flag check runs in an effect (not initial state) because
  // permission grants can resolve asynchronously after first render.
  useEffect(() => {
    if (showTour || needsSetup || showActivation) return;
    if (shouldShowActivationTour()) setShowActivation(true);
  }, [showTour, needsSetup, showActivation]);

  const dismissActivation = useCallback(() => {
    setShowActivation(false);
  }, []);

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
      } else if (!needsSetup && !showActivation) {
        // Activation tour expects focus to move to other apps (step 2's
        // "paste anywhere", step 4's ⌘⇧V from another app) — don't auto-
        // hide the panel during it.
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
  }, [checkPermissions, needsSetup, showActivation]);

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

  // Surface the nudge or record why it was suppressed. Shared between
  // the new-selection (affirmation) and manual-copy (corrective) paths
  // so both branches see the same observability shape in PostHog.
  const runNudge = useCallback((decision: NudgeDecision, kind: "affirmation" | "corrective") => {
    if (decision.show) {
      safeInvoke("show_nudge", { kind: decision.kind, text: decision.text }).catch(() => {});
      track("nudge_shown", {
        kind: decision.kind,
        selects_total_bucket: bucket(decision.selects),
      });
    } else {
      track("nudge_suppressed", { kind, reason: decision.reason });
    }
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
      runNudge(decideAffirmation(), "affirmation");
    });
    return () => { unlisten.then(fn => fn()); };
  }, [runNudge]);

  // The Rust copy processor emits `capture-suppressed` when it declines to
  // auto-copy because focus is inside an editable text field (drag-to-replace
  // gesture). Forward it as analytics so we can see the AX path firing in
  // the wild.
  useEffect(() => {
    const unlisten = listen<string>("capture-suppressed", event => {
      track("selection_capture_failed", { reason: event.payload || "unknown" });
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // The Rust manual-copy processor emits `manual-copy` when the user pressed
  // Cmd+C/Ctrl+C themselves within 5s of a Pluks capture. We forward as a
  // PostHog event and ask the nudge engine whether to surface a corrective
  // — only fires for partial adopters (5–95% redundancy), so we don't
  // pester non-adopters or full converts.
  useEffect(() => {
    const unlisten = listen<string>("manual-copy", event => {
      track("manual_copy_pressed", { since_last_capture_ms_bucket: event.payload });
      runNudge(decideCorrective(), "corrective");
    });
    return () => { unlisten.then(fn => fn()); };
  }, [runNudge]);

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
      if (e.key !== RELEASE_KEY) return;
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

  if (showTour) {
    return (
      <div className="panel panel-setup">
        <Titlebar />
        <OnboardingTour onDone={dismissTour} />
      </div>
    );
  }

  if (needsSetup) {
    return (
      <div className="panel panel-setup">
        <Titlebar>
          {!IS_MAC && (
            <button
              className="setup-dismiss"
              title="Hide window — re-open from the menu-bar icon"
              onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
              onClick={hideWindow}
            >Hide ✕</button>
          )}
        </Titlebar>
        <SetupScreen hasAccessibility={hasAccessibility} hasInputMonitoring={hasInputMonitoring} onCheck={checkPermissions} />
      </div>
    );
  }

  if (showActivation) {
    return (
      <div className="panel panel-setup">
        <Titlebar />
        <ActivationTour onDone={dismissActivation} />
      </div>
    );
  }

  if (prefsOpen) {
    return (
      <div className="panel">
        <Titlebar>
          <button className="gear-btn active" title="Close preferences" onClick={() => setPrefsOpen(false)}>←</button>
        </Titlebar>
        <PreferencesScreen onClose={() => setPrefsOpen(false)} />
      </div>
    );
  }

  return (
    <div className="panel">
      <Titlebar>
        <span className="count" data-tauri-drag-region>{items.length} / 100</span>
        <button
          className="gear-btn"
          title="Preferences"
          onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
          onClick={() => setPrefsOpen(true)}
        >⚙</button>
      </Titlebar>

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

      <UpdateBanner />

      <div className="panel-footer">
        <button className="btn-clear" onClick={handleClear}>Clear all</button>
        <span className="hint">↑↓ navigate · ↩ copy · ⌫ delete · esc close · {SHORTCUT_HINT} toggle</span>
      </div>
    </div>
  );
}
