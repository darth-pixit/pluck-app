// Background auto-update with zero session loss.
//
// Flow:
//   1. On launch (5 s after boot, so we don't fight permission prompts) and
//      every CHECK_INTERVAL_MS thereafter, ask Tauri's updater for a manifest.
//   2. If a newer version exists, download the signed archive in the
//      background — the user keeps using the app uninterrupted.
//   3. Once download completes, surface a small banner with parsed release
//      highlights. The user can install now (clean relaunch) or defer.
//   4. If deferred, we install automatically when the user quits via the tray
//      ("Quit Pluks") — the frontend listens for `app-quit-requested` and runs
//      installUpdate before Rust exits. No data loss because:
//        • history is in SQLite (durable)
//        • settings are persisted to disk
//        • the panel has no in-flight user input at quit time
//
// We intentionally do NOT auto-install while the app is running, because on
// macOS that would terminate the host process and drop any open panel state.

import { listen } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { track } from "./analytics";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;   // every 6h
const INITIAL_CHECK_DELAY_MS = 5_000;           // wait 5 s after boot
const LAST_NOTES_KEY = "pluks.update.lastShownVersion";

export type UpdateStatus =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "downloading"; progress: number /* 0..1, -1 if unknown */ }
  | { phase: "ready"; version: string; highlights: string[] }
  | { phase: "installing" }
  | { phase: "error"; message: string };

type Listener = (s: UpdateStatus) => void;

let status: UpdateStatus = { phase: "idle" };
let staged: Update | null = null;
let listeners = new Set<Listener>();
let started = false;

function setStatus(next: UpdateStatus) {
  status = next;
  for (const l of listeners) l(next);
}

export function getUpdateStatus(): UpdateStatus {
  return status;
}

export function subscribeUpdateStatus(fn: Listener): () => void {
  listeners.add(fn);
  fn(status);
  return () => { listeners.delete(fn); };
}

/**
 * Parse a small set of user-relevant highlights from a release-notes body.
 * We accept the standard Markdown bullet lines that GitHub/CHANGELOG entries
 * already use, strip Markdown emphasis, and cap at MAX_HIGHLIGHTS so the
 * banner stays glanceable.
 */
const MAX_HIGHLIGHTS = 4;
export function parseHighlights(body: string | undefined | null): string[] {
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  const bullets: string[] = [];
  for (const raw of lines) {
    const m = raw.match(/^\s*[-*+]\s+(.+?)\s*$/);
    if (!m) continue;
    const cleaned = m[1]
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .trim();
    if (cleaned.length > 0 && cleaned.length <= 140) bullets.push(cleaned);
    if (bullets.length >= MAX_HIGHLIGHTS) break;
  }
  return bullets;
}

async function checkAndStage(): Promise<void> {
  // Don't clobber an in-flight download or a ready-to-install update.
  if (status.phase === "downloading" || status.phase === "ready" || status.phase === "installing") {
    return;
  }
  setStatus({ phase: "checking" });
  try {
    const update = await check();
    if (!update) {
      setStatus({ phase: "idle" });
      return;
    }
    track("update_available", { version: update.version });

    let totalBytes = 0;
    let downloadedBytes = 0;
    setStatus({ phase: "downloading", progress: 0 });

    // downloadAndInstall would terminate the app immediately; we want the
    // download but defer the install, so we use the lower-level pair.
    await update.download((event) => {
      switch (event.event) {
        case "Started":
          totalBytes = event.data.contentLength ?? 0;
          break;
        case "Progress":
          downloadedBytes += event.data.chunkLength;
          setStatus({
            phase: "downloading",
            progress: totalBytes > 0 ? downloadedBytes / totalBytes : -1,
          });
          break;
        case "Finished":
          break;
      }
    });

    staged = update;
    const highlights = parseHighlights(update.body);
    setStatus({ phase: "ready", version: update.version, highlights });
    track("update_downloaded", {
      version: update.version,
      highlight_count: highlights.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Network failures during a background poll aren't worth alarming the
    // user — we silently revert to idle and try again next interval. Only
    // surface errors that happen during an explicit user-initiated check.
    console.warn("[pluks updater] check failed:", message);
    setStatus({ phase: "idle" });
    track("update_check_failed", { message: message.slice(0, 200) });
  }
}

/** Apply the staged update and relaunch. Caller should ensure no unsaved work. */
export async function installStagedUpdate(): Promise<void> {
  if (!staged || status.phase !== "ready") return;
  const version = staged.version;
  setStatus({ phase: "installing" });
  track("update_install_started", { version });
  try {
    await staged.install();
    await relaunch();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    track("update_install_failed", { version, message: message.slice(0, 200) });
    setStatus({ phase: "error", message });
  }
}

/**
 * User dismissed the banner ("Later"). The staged update stays in memory so
 * install-on-quit still runs; we just persist that we've already shown notes
 * for this version. The banner manages its own visibility flag.
 */
export function markUpdateNoticeDismissed(version: string): void {
  try { localStorage.setItem(LAST_NOTES_KEY, version); } catch { /* ignore */ }
  track("update_dismissed", { version });
}

export function shouldShowNoticeFor(version: string): boolean {
  try {
    return localStorage.getItem(LAST_NOTES_KEY) !== version;
  } catch {
    return true;
  }
}

/** Manual recheck from a UI control. */
export function checkForUpdatesNow(): Promise<void> {
  return checkAndStage();
}

/**
 * Start the background updater. Idempotent — safe to call from a useEffect
 * that re-runs in StrictMode.
 */
export function startUpdater(): void {
  if (started) return;
  started = true;

  setTimeout(() => { void checkAndStage(); }, INITIAL_CHECK_DELAY_MS);
  setInterval(() => { void checkAndStage(); }, CHECK_INTERVAL_MS);

  // Install on graceful quit so the next launch is the new version.
  // Tray "Quit" emits app-quit-requested then waits ~800ms for us.
  void listen("app-quit-requested", async () => {
    if (staged && status.phase === "ready") {
      try {
        track("update_install_on_quit", { version: staged.version });
        await staged.install();
      } catch (err) {
        console.warn("[pluks updater] install-on-quit failed:", err);
      }
    }
  });
}
