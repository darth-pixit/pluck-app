/**
 * Pluks extension analytics — minimal fetch client for PostHog + Sentry.
 *
 * Loaded by background.js (importScripts), popup.html (<script>), and
 * content.js (manifest content_scripts.js array). Exposes `Pluks` on the
 * appropriate global (self in SW, window in popup/content).
 *
 * Anonymous-by-default. Never sends clipboard content, page URLs,
 * hostnames, page titles, or any PII.
 */
(function () {
  "use strict";

  var GLOBAL = (typeof self !== "undefined") ? self : window;
  if (GLOBAL.Pluks) return;

  var CFG = GLOBAL.PLUKS_CONFIG || {};
  var POSTHOG_KEY  = CFG.POSTHOG_KEY  || "";
  var POSTHOG_HOST = CFG.POSTHOG_HOST || "https://us.i.posthog.com";
  var SENTRY_DSN   = CFG.SENTRY_DSN   || "";

  function isRealKey(s) { return !!s && s.indexOf("PLACEHOLDER") === -1; }

  var KEY_ANON    = "pluks_anon_id";
  var KEY_OPT_OUT = "pluks_opt_out";
  var KEY_LAST_VER = "pluks_last_seen_version";

  // ── Whitelist of allowed event property keys ────────────────────────────
  var SCHEMA = {
    app_installed:           ["install_source"],
    app_updated:             ["from_version", "to_version"],
    app_launched:            ["cold_start", "since_last_launch_ms"],
    analytics_opted_out:     [],
    analytics_opted_in:      [],
    selection_captured:      ["char_count_bucket", "was_drag", "was_multi_click", "scheme", "content_kind"],
    selection_capture_failed:["reason"],
    toast_shown:             ["char_count_bucket"],
    popup_opened:            ["item_count"],
    popup_history_clicked:   ["position", "char_count_bucket"],
    popup_searched:          ["query_length_bucket", "result_count"],
    popup_history_cleared:   ["item_count_before"],
    error_uncaught_js:       ["error_type", "error_message_hash", "where"]
  };

  var DENY_RX = /^(text|content|url|selection|email|path|host|hostname|page_title|tab_url|secret|token|password)$/i;

  // ── Storage helpers (chrome.storage.local) ──────────────────────────────
  function storageGet(keys) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(keys, function (v) { resolve(v || {}); });
      } catch (_) { resolve({}); }
    });
  }
  function storageSet(obj) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.set(obj, function () { resolve(); }); }
      catch (_) { resolve(); }
    });
  }

  // ── Identity ────────────────────────────────────────────────────────────
  var _anonId = null;
  var _optOut = false;

  async function ensureIdentity() {
    var v = await storageGet([KEY_ANON, KEY_OPT_OUT]);
    if (v[KEY_ANON]) {
      _anonId = v[KEY_ANON];
    } else {
      _anonId = (crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : ("anon-" + Math.random().toString(36).slice(2) + Date.now().toString(36));
      await storageSet({ [KEY_ANON]: _anonId });
    }
    _optOut = !!v[KEY_OPT_OUT];
  }

  // Keep opt-out in sync if changed elsewhere (popup → all surfaces).
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local") return;
      if (changes[KEY_OPT_OUT]) _optOut = !!changes[KEY_OPT_OUT].newValue;
    });
  } catch (_) {}

  // ── Super properties ────────────────────────────────────────────────────
  function detectBrowser() {
    try {
      if (typeof navigator !== "undefined" && /firefox/i.test(navigator.userAgent)) return "firefox";
    } catch (_) {}
    return "chrome";
  }

  function superProps() {
    var manifest = {};
    try { manifest = chrome.runtime.getManifest() || {}; } catch (_) {}
    var locale = "unknown";
    try { locale = chrome.i18n.getUILanguage() || locale; } catch (_) {}
    return {
      surface: "ext",
      ext_version: manifest.version || "0.0.0",
      browser: detectBrowser(),
      locale: locale,
      $lib: "pluks-ext"
    };
  }

  // ── Bucket helpers ──────────────────────────────────────────────────────
  function bucket(n) {
    if (n <= 10) return "1-10";
    if (n <= 100) return "11-100";
    if (n <= 1000) return "101-1000";
    if (n <= 10000) return "1001-10000";
    return "10000+";
  }

  // ── Whitelist event props ───────────────────────────────────────────────
  function whitelist(event, props) {
    var allowed = SCHEMA[event];
    if (!allowed) return null;
    var out = {};
    for (var i = 0; i < allowed.length; i++) {
      var k = allowed[i];
      if (props && k in props && !DENY_RX.test(k)) out[k] = props[k];
    }
    return out;
  }

  // ── PostHog send ────────────────────────────────────────────────────────
  async function track(event, props) {
    try {
      if (!_anonId) await ensureIdentity();
      if (_optOut || !isRealKey(POSTHOG_KEY)) return;
      var clean = whitelist(event, props || {});
      if (!clean) return;
      var body = {
        api_key: POSTHOG_KEY,
        event: event,
        distinct_id: _anonId,
        properties: Object.assign({}, superProps(), clean),
        timestamp: new Date().toISOString()
      };
      await fetch(POSTHOG_HOST + "/i/v0/e/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
        credentials: "omit"
      });
    } catch (_) { /* swallow analytics errors */ }
  }

  // ── Sentry envelope send (minimal) ──────────────────────────────────────
  function parseDsn(dsn) {
    try {
      var u = new URL(dsn);
      var projectId = u.pathname.replace(/^\//, "");
      return {
        publicKey: u.username,
        host: u.host,
        protocol: u.protocol.replace(":", ""),
        projectId: projectId,
        envelopeUrl: u.protocol + "//" + u.host + "/api/" + projectId + "/envelope/"
      };
    } catch (_) { return null; }
  }
  var _dsn = isRealKey(SENTRY_DSN) ? parseDsn(SENTRY_DSN) : null;

  function scrubPaths(s) {
    if (typeof s !== "string") return s;
    return s.replace(/(\/Users\/|\/home\/)[^\/"\\]+/g, "$1~");
  }

  async function captureException(err, ctxLabel) {
    try {
      if (!_anonId) await ensureIdentity();
      if (_optOut || !_dsn) return;
      var manifest = {};
      try { manifest = chrome.runtime.getManifest() || {}; } catch (_) {}
      var event = {
        event_id: (crypto && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)).replace(/-/g, ""),
        timestamp: Date.now() / 1000,
        platform: "javascript",
        release: "pluks-ext@" + (manifest.version || "0.0.0"),
        environment: "production",
        user: { id: _anonId },
        tags: { surface: "ext", browser: detectBrowser(), where: ctxLabel || "unknown" },
        exception: {
          values: [{
            type: (err && err.name) || "Error",
            value: scrubPaths((err && err.message) || String(err)),
            stacktrace: err && err.stack ? { frames: parseStack(err.stack) } : undefined
          }]
        }
      };
      var headers = { event_id: event.event_id, sent_at: new Date().toISOString(), dsn: SENTRY_DSN };
      var item = { type: "event" };
      var envelope =
        JSON.stringify(headers) + "\n" +
        JSON.stringify(item) + "\n" +
        JSON.stringify(event);

      await fetch(_dsn.envelopeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-sentry-envelope" },
        body: envelope,
        keepalive: true,
        credentials: "omit"
      });
    } catch (_) {}

    // Mirror as a count event in PostHog (no message content).
    track("error_uncaught_js", {
      error_type: (err && err.name) || "Error",
      error_message_hash: hashShort((err && err.message) || ""),
      where: ctxLabel || "unknown"
    });
  }

  function parseStack(stack) {
    return String(stack).split("\n").slice(0, 30).map(function (line) {
      return { filename: scrubPaths(line.trim()), function: "?", in_app: true };
    });
  }

  function hashShort(s) {
    var h = 5381; s = String(s || "");
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16).slice(0, 8);
  }

  // ── Wrap a function so any throw lands in Sentry ────────────────────────
  function wrap(fn, label) {
    return function () {
      try { return fn.apply(this, arguments); }
      catch (e) { captureException(e, label || "wrap"); throw e; }
    };
  }

  // ── Lifecycle helpers ───────────────────────────────────────────────────
  async function reportLaunchAndUpdate() {
    var manifest = {};
    try { manifest = chrome.runtime.getManifest() || {}; } catch (_) {}
    var v = await storageGet([KEY_LAST_VER]);
    var cur = manifest.version || "0.0.0";
    if (!v[KEY_LAST_VER]) {
      track("app_installed", { install_source: detectBrowser() });
    } else if (v[KEY_LAST_VER] !== cur) {
      track("app_updated", { from_version: v[KEY_LAST_VER], to_version: cur });
    }
    await storageSet({ [KEY_LAST_VER]: cur });
    track("app_launched", { cold_start: true });
  }

  // ── Opt-out controls ────────────────────────────────────────────────────
  async function setOptOut(v) {
    _optOut = !!v;
    await storageSet({ [KEY_OPT_OUT]: _optOut });
    // Fire one final event acknowledging the choice (only on opt-in).
    if (!_optOut) track("analytics_opted_in", {});
  }
  async function isOptedOut() {
    if (_anonId === null) await ensureIdentity();
    return _optOut;
  }

  // ── Global error capture (works in SW + popup; content has its own catch) ──
  try {
    GLOBAL.addEventListener("error", function (ev) {
      captureException(ev.error || new Error(ev.message || "error"), "global");
    });
    GLOBAL.addEventListener("unhandledrejection", function (ev) {
      var r = ev.reason;
      var e = (r instanceof Error) ? r : new Error(typeof r === "string" ? r : JSON.stringify(r || {}));
      e.name = "UnhandledRejection";
      captureException(e, "rejection");
    });
  } catch (_) {}

  // ── Public API ──────────────────────────────────────────────────────────
  GLOBAL.Pluks = {
    track: track,
    captureException: captureException,
    wrap: wrap,
    setOptOut: setOptOut,
    isOptedOut: isOptedOut,
    bucket: bucket,
    ensureIdentity: ensureIdentity,
    reportLaunchAndUpdate: reportLaunchAndUpdate,
    anonId: function () { return _anonId; }
  };

  // Eagerly load identity so first track() call doesn't drop the event.
  ensureIdentity();
})();
