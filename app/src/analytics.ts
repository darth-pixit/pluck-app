/**
 * Pluks desktop-app analytics (PostHog) and error reporting (Sentry).
 *
 * Anonymous-by-default. Reads opt-out from Tauri-managed `settings.json`
 * via `get_settings`/`set_settings` invokes. Never sends clipboard
 * content, history `content`, hostnames, page URLs, file paths, or PII.
 */
import { invoke } from "@tauri-apps/api/core";
import * as Sentry from "@sentry/react";
import posthog from "posthog-js";

const POSTHOG_KEY  = (import.meta.env.VITE_POSTHOG_KEY  as string) || "";
const POSTHOG_HOST = (import.meta.env.VITE_POSTHOG_HOST as string) || "https://us.i.posthog.com";
const SENTRY_DSN   = (import.meta.env.VITE_SENTRY_DSN   as string) || "";
const APP_VERSION  = (import.meta.env.VITE_APP_VERSION  as string) || "0.0.0";

const isRealKey = (s: string) => !!s && !s.includes("PLACEHOLDER");

if (!isRealKey(POSTHOG_KEY)) console.warn("[pluks-app] PostHog disabled — placeholder key in use");
if (!isRealKey(SENTRY_DSN))  console.warn("[pluks-app] Sentry disabled — placeholder DSN in use");

// Allowed property keys per event. `track()` drops anything not on the list.
const SCHEMA: Record<string, readonly string[]> = {
  app_installed:                 [],
  app_updated:                   ["from_version", "to_version"],
  app_launched:                  ["cold_start", "since_last_launch_ms"],
  analytics_opted_out:           [],
  analytics_opted_in:            [],
  crash_report_opted_out:        [],
  crash_report_opted_in:         [],

  panel_opened:                  ["trigger", "had_focus_target"],
  panel_closed:                  ["dismiss_reason", "open_duration_ms"],
  panel_open_latency_ms:         ["ms"],

  selection_captured:            ["char_count_bucket", "kind", "capture_latency_ms", "had_clipboard_change"],
  selection_capture_failed:      ["reason"],
  auto_copy_toggled:             ["enabled"],
  autostart_enabled:             [],

  permission_check:              ["accessibility_granted", "input_monitoring_granted"],
  permission_grant_clicked:      ["permission"],
  permission_granted:            ["permission", "seconds_since_first_seen"],
  permission_denied_or_skipped:  ["permission"],

  history_loaded:                ["item_count", "load_ms"],
  history_item_clicked:          ["position", "kind", "char_count_bucket"],
  history_item_pasted_keyboard:  ["position", "kind"],
  history_item_deleted:          ["position", "via"],
  history_cleared:               ["item_count_before"],
  history_searched:              ["query_length_bucket", "result_count"],
  history_navigated_keyboard:    ["direction", "from_index", "to_index"],
  smart_paste_used:              ["kind", "action_label"],

  error_uncaught_js:             ["error_type", "error_message_hash", "where"],
  error_tauri_invoke_failed:     ["command", "error_type"],
  error_rust_panic:              ["module", "thread"]
};

const DENY_RX = /^(text|content|url|selection|email|path|hostname|page_title|secret|token|password)$/i;

export function bucket(n: number): string {
  if (n <= 10) return "1-10";
  if (n <= 100) return "11-100";
  if (n <= 1000) return "101-1000";
  if (n <= 10000) return "1001-10000";
  return "10000+";
}

export interface Settings {
  anon_id: string;
  opt_out: boolean;
  crash_opt_out: boolean;
  analytics_first_seen_version: string;
  last_seen_version: string;
}

let _settings: Settings | null = null;
let _initialized = false;
let _osPlatform = "unknown";
let _osVersion = "unknown";

function loadOsContext() {
  // We deliberately avoid the @tauri-apps/plugin-os crate so we don't have to
  // register a Rust-side plugin. navigator.userAgent is plenty for coarse OS
  // bucketing in product analytics.
  const ua = navigator.userAgent || "";
  if (/Mac OS X/i.test(ua))      _osPlatform = "macos";
  else if (/Windows/i.test(ua))  _osPlatform = "windows";
  else if (/Linux/i.test(ua))    _osPlatform = "linux";
  else                           _osPlatform = "unknown";
  const m = ua.match(/Mac OS X ([\d_]+)/) || ua.match(/Windows NT ([\d.]+)/);
  _osVersion = m ? m[1].replace(/_/g, ".") : "unknown";
}

function superProps() {
  return {
    surface: "app" as const,
    app_version: APP_VERSION,
    os_platform: _osPlatform,
    os_version: _osVersion,
    locale: navigator.language || "unknown"
  };
}

function whitelist(event: string, props: Record<string, unknown>): Record<string, unknown> | null {
  const allowed = SCHEMA[event];
  if (!allowed) return null;
  const out: Record<string, unknown> = {};
  for (const k of allowed) {
    if (k in props && !DENY_RX.test(k)) out[k] = props[k];
  }
  return out;
}

function scrubPaths(s: string): string {
  return s.replace(/(\/Users\/|\/home\/)[^\/"\\]+/g, "$1~");
}

export async function initAnalytics(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  loadOsContext();

  try {
    _settings = await invoke<Settings>("get_settings");
  } catch (e) {
    // Settings command not yet available (e.g. dev rebuild); use safe defaults.
    _settings = {
      anon_id: "anon-" + Math.random().toString(36).slice(2),
      opt_out: false,
      crash_opt_out: false,
      analytics_first_seen_version: APP_VERSION,
      last_seen_version: APP_VERSION
    };
  }

  // PostHog
  if (isRealKey(POSTHOG_KEY)) {
    try {
      posthog.init(POSTHOG_KEY, {
        api_host: POSTHOG_HOST,
        autocapture: false,
        capture_pageview: false,
        disable_session_recording: true,
        persistence: "localStorage",
        bootstrap: { distinctID: _settings.anon_id },
        opt_out_capturing_by_default: _settings.opt_out,
        sanitize_properties: (props) => {
          for (const k of Object.keys(props)) {
            if (DENY_RX.test(k)) delete (props as Record<string, unknown>)[k];
          }
          return props;
        }
      });
    } catch {}
  }

  // Sentry
  if (isRealKey(SENTRY_DSN) && !_settings.crash_opt_out) {
    try {
      Sentry.init({
        dsn: SENTRY_DSN,
        release: `pluks-app@${APP_VERSION}`,
        tracesSampleRate: 0,
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,
        beforeSend: (event) => {
          if (_settings?.crash_opt_out) return null;
          try {
            const s = JSON.stringify(event);
            return JSON.parse(s.replace(/(\/Users\/|\/home\/)[^\/"\\]+/g, "$1~"));
          } catch {
            return event;
          }
        }
      });
      Sentry.getCurrentScope().setUser({ id: _settings.anon_id });
      Sentry.getCurrentScope().setTag("surface", "app");
    } catch {}
  }

  // Lifecycle: install / update / launch
  if (!_settings.last_seen_version) {
    track("app_installed", {});
  } else if (_settings.last_seen_version !== APP_VERSION) {
    track("app_updated", { from_version: _settings.last_seen_version, to_version: APP_VERSION });
  }
  track("app_launched", { cold_start: true });

  // Persist current version so subsequent launches detect updates correctly.
  if (_settings.last_seen_version !== APP_VERSION) {
    try {
      _settings.last_seen_version = APP_VERSION;
      if (!_settings.analytics_first_seen_version) {
        _settings.analytics_first_seen_version = APP_VERSION;
      }
      await invoke("set_settings", { settings: _settings });
    } catch {}
  }
}

export type EventName = keyof typeof SCHEMA;

export function track(event: EventName, props: Record<string, unknown> = {}): void {
  if (!_settings || _settings.opt_out) return;
  if (!isRealKey(POSTHOG_KEY)) return;
  const clean = whitelist(event, props);
  if (!clean) return;
  try {
    posthog.capture(event, { ...superProps(), ...clean });
  } catch {}
}

export function captureException(err: unknown, ctx?: { where?: string }): void {
  if (_settings?.crash_opt_out) return;
  try {
    Sentry.captureException(err, scope => {
      if (ctx?.where) scope.setTag("where", ctx.where);
      return scope;
    });
  } catch {}
  // Mirror as a count event in PostHog (no message body, just a hash).
  const e = err as Error;
  const msg = (e?.message || String(err) || "").slice(0, 256);
  let h = 5381;
  for (let i = 0; i < msg.length; i++) h = ((h << 5) + h + msg.charCodeAt(i)) | 0;
  track("error_uncaught_js", {
    error_type: e?.name || "Error",
    error_message_hash: (h >>> 0).toString(16).slice(0, 8),
    where: ctx?.where || "unknown"
  });
}

/**
 * Wrapper around Tauri's `invoke` that auto-reports failures to Sentry/PostHog.
 * Use this everywhere instead of the raw `invoke` to get crash visibility.
 */
export async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    const e = err as Error;
    track("error_tauri_invoke_failed", { command: cmd, error_type: e?.name || "Error" });
    try { Sentry.captureException(err, scope => { scope.setTag("invoke_command", cmd); return scope; }); } catch {}
    throw err;
  }
}

export async function setOptOut(optOut: boolean): Promise<void> {
  if (!_settings) return;
  if (optOut && !_settings.opt_out) track("analytics_opted_out", {});
  _settings.opt_out = optOut;
  try {
    if (optOut) posthog.opt_out_capturing();
    else posthog.opt_in_capturing();
  } catch {}
  if (!optOut) track("analytics_opted_in", {});
  try { await invoke("set_settings", { settings: _settings }); } catch {}
}

export async function setCrashOptOut(optOut: boolean): Promise<void> {
  if (!_settings) return;
  if (optOut && !_settings.crash_opt_out) track("crash_report_opted_out", {});
  _settings.crash_opt_out = optOut;
  if (!optOut) track("crash_report_opted_in", {});
  try { await invoke("set_settings", { settings: _settings }); } catch {}
}

export function getSettings(): Settings | null {
  return _settings ? { ..._settings } : null;
}

export async function resetAnonymousId(): Promise<void> {
  if (!_settings) return;
  _settings.anon_id = crypto.randomUUID();
  try { await invoke("set_settings", { settings: _settings }); } catch {}
  try { posthog.reset(); posthog.identify(_settings.anon_id); } catch {}
}

// Window-level error capture
window.addEventListener("error", (ev) => {
  captureException(ev.error || new Error(scrubPaths(ev.message || "error")), { where: "window.error" });
});
window.addEventListener("unhandledrejection", (ev) => {
  const r = ev.reason;
  const e = r instanceof Error ? r : new Error(typeof r === "string" ? scrubPaths(r) : "UnhandledRejection");
  e.name = "UnhandledRejection";
  captureException(e, { where: "unhandledrejection" });
});

// Re-export Sentry's ErrorBoundary so callers can wrap their UI without a
// second Sentry import.
export const ErrorBoundary = Sentry.ErrorBoundary;
