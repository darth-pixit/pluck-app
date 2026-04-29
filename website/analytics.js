/**
 * Pluks website analytics (PostHog) and error reporting (Sentry).
 *
 * Honors `navigator.doNotTrack` and a `?opt_out=1` URL param. Never sends
 * the content of selections, page URLs beyond pluks.app, or any PII.
 *
 * The PostHog and Sentry loader snippets in index.html make
 * `window.posthog` and `window.Sentry` available; this file boots them and
 * wires up CTA tracking.
 */
(function () {
  "use strict";

  var POSTHOG_KEY  = "phc_PLACEHOLDER_REPLACE_AT_DEPLOY";
  var POSTHOG_HOST = "https://us.i.posthog.com";
  var SENTRY_DSN   = "https://PLACEHOLDER_REPLACE_AT_DEPLOY@o0.ingest.sentry.io/0";
  var RELEASE      = "pluks-web@2026.04";

  function isRealKey(s) { return !!s && s.indexOf("PLACEHOLDER") === -1; }

  var KEY_OPT_OUT = "pluks_opt_out";
  var KEY_ANON    = "pluks_anon_id";

  function urlOptOut() {
    try { return /[?&]opt_out=1/.test(location.search); } catch (_) { return false; }
  }
  function dnt() {
    return navigator.doNotTrack === "1" || window.doNotTrack === "1";
  }
  function persistOptOut(v) {
    try { localStorage.setItem(KEY_OPT_OUT, v ? "1" : "0"); } catch (_) {}
  }
  function readOptOut() {
    if (dnt()) return true;
    if (urlOptOut()) { persistOptOut(true); return true; }
    try { return localStorage.getItem(KEY_OPT_OUT) === "1"; } catch (_) { return false; }
  }

  function anonId() {
    try {
      var v = localStorage.getItem(KEY_ANON);
      if (v) return v;
      v = (crypto && crypto.randomUUID) ? crypto.randomUUID() :
          ("xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0;
            return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
          }));
      localStorage.setItem(KEY_ANON, v);
      return v;
    } catch (_) {
      return "anon-no-storage";
    }
  }

  // Allowed property keys per event. `track()` drops anything not on the list.
  var SCHEMA = {
    page_view:               ["path", "referrer_host", "viewport_w"],
    scroll_depth:            ["percent"],
    download_clicked:        ["platform", "cta_location"],
    download_modal_opened:   ["platform"],
    download_modal_closed:   ["platform", "via"],
    download_form_submitted: ["platform", "persona"],
    download_form_invalid:   ["reason"],
    github_link_clicked:     ["link_target"],
    nav_clicked:             ["target"],
    demo_interacted:         ["selection_chars_bucket"],
    demo_completed:          ["time_to_complete_ms"],
    privacy_viewed:          ["from_path"],
    error_uncaught_js:       ["error_type", "error_message_hash"]
  };

  // Aligned with app/src/analytics.ts and extension/analytics.js — exact-match
  // anchors so a key like `email_hash` isn't accidentally flagged.
  var DENY_RX = /^(text|content|url|selection|email|path|host|hostname|page_title|tab_url|secret|token|password)$/i;

  function bucket(n) {
    if (n <= 10) return "1-10";
    if (n <= 100) return "11-100";
    if (n <= 1000) return "101-1000";
    if (n <= 10000) return "1001-10000";
    return "10000+";
  }

  function superProps() {
    return {
      surface: "web",
      release: RELEASE,
      locale: navigator.language || "unknown",
      viewport_w: window.innerWidth,
      viewport_h: window.innerHeight,
      referrer_host: (function () {
        try { return document.referrer ? new URL(document.referrer).hostname : ""; }
        catch (_) { return ""; }
      })()
    };
  }

  function whitelistProps(event, props) {
    var allowed = SCHEMA[event];
    if (!allowed) return null; // unknown event — refuse to send
    var out = {};
    for (var i = 0; i < allowed.length; i++) {
      var k = allowed[i];
      if (props && k in props) out[k] = props[k];
    }
    // Defensive scrub against accidental sensitive keys
    for (var k2 in out) if (DENY_RX.test(k2)) delete out[k2];
    return out;
  }

  var optedOut = readOptOut();

  function track(event, props) {
    if (optedOut) return;
    if (!window.posthog) return;
    var clean = whitelistProps(event, props || {});
    if (!clean) return;
    try {
      window.posthog.capture(event, Object.assign({}, superProps(), clean));
    } catch (_) {}
  }

  function captureException(err) {
    if (optedOut) return;
    try { if (window.Sentry) window.Sentry.captureException(err); } catch (_) {}
  }

  // ── Init PostHog ────────────────────────────────────────────────────────
  if (window.posthog && typeof window.posthog.init === "function" && isRealKey(POSTHOG_KEY)) {
    try {
      window.posthog.init(POSTHOG_KEY, {
        api_host: POSTHOG_HOST,
        autocapture: false,
        capture_pageview: false,
        disable_session_recording: true,
        persistence: "localStorage",
        bootstrap: { distinctID: anonId() },
        respect_dnt: true,
        opt_out_capturing_by_default: optedOut,
        sanitize_properties: function (props) {
          for (var k in props) if (DENY_RX.test(k)) delete props[k];
          return props;
        }
      });
    } catch (_) {}
  }

  // ── Init Sentry ─────────────────────────────────────────────────────────
  if (window.Sentry && typeof window.Sentry.init === "function" && !optedOut && isRealKey(SENTRY_DSN)) {
    try {
      window.Sentry.init({
        dsn: SENTRY_DSN,
        release: RELEASE,
        tracesSampleRate: 0,
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,
        beforeSend: function (event) {
          // Strip HOME-like absolute paths if any leak through.
          try {
            var s = JSON.stringify(event);
            s = s.replace(/(\/Users\/|\/home\/)[^\/"\\]+/g, "$1~");
            return JSON.parse(s);
          } catch (_) { return event; }
        }
      });
      window.Sentry.setUser({ id: anonId() });
    } catch (_) {}
  }

  // ── page_view + privacy_viewed ──────────────────────────────────────────
  var path = location.pathname || "/";
  if (/privacy\.html?$/.test(path)) {
    track("privacy_viewed", { from_path: document.referrer ? new URL(document.referrer).pathname : "" });
  } else {
    track("page_view", {
      path: path,
      referrer_host: superProps().referrer_host,
      viewport_w: window.innerWidth
    });
  }

  // ── Scroll depth ────────────────────────────────────────────────────────
  var DEPTHS = [25, 50, 75, 100];
  var hit = {};
  function onScroll() {
    var doc = document.documentElement;
    var max = doc.scrollHeight - window.innerHeight;
    if (max <= 0) return;
    var pct = Math.round((window.scrollY / max) * 100);
    for (var i = 0; i < DEPTHS.length; i++) {
      var d = DEPTHS[i];
      if (pct >= d && !hit[d]) { hit[d] = true; track("scroll_depth", { percent: d }); }
    }
  }
  window.addEventListener("scroll", onScroll, { passive: true });

  // ── CTA delegation ──────────────────────────────────────────────────────
  function ctaLocation(el) {
    var section = el.closest("section, footer, nav");
    if (!section) return "unknown";
    if (section.classList.contains("hero")) return "hero";
    if (section.classList.contains("download")) return "download";
    if (section.classList.contains("extension-section")) return "extension";
    if (section.classList.contains("features")) return "features";
    if (section.classList.contains("footer")) return "footer";
    if (section.classList.contains("nav")) return "nav";
    return section.id || section.className.split(" ")[0] || "unknown";
  }

  function platformFromEl(el) {
    var id = el.id || "";
    if (id === "dl-mac")   return /Intel/.test(navigator.userAgent) ? "mac_intel" : "mac";
    if (id === "dl-win")   return "win";
    if (id === "dl-linux") return "linux_appimage";
    if (/dmg/i.test(el.href || "")) return /Intel|x64/.test(el.href) ? "mac_intel" : "mac";
    if (/msi/i.test(el.href || "")) return "win";
    if (/AppImage/i.test(el.href || "")) return "linux_appimage";
    if (/\.deb/i.test(el.href || "")) return "linux_deb";
    return "unknown";
  }

  document.addEventListener("click", function (e) {
    var el = e.target;
    while (el && el !== document.body) {
      if (el.tagName === "A") break;
      el = el.parentNode;
    }
    if (!el || el.tagName !== "A") return;
    var href = el.getAttribute("href") || "";

    if (el.classList.contains("btn-download") || /releases/.test(href)) {
      track("download_clicked", { platform: platformFromEl(el), cta_location: ctaLocation(el) });
    }
    if (/github\.com/.test(href)) {
      track("github_link_clicked", { link_target: /releases/.test(href) ? "releases" : (/issues/.test(href) ? "issues" : "repo") });
    }
    if (el.classList.contains("nav-cta") || el.classList.contains("nav-ext") || el.closest(".nav")) {
      track("nav_clicked", { target: (href.replace(/^.*#/, "#") || "").slice(0, 32) });
    }
  });

  // ── Uncaught errors → mirror to PostHog ─────────────────────────────────
  function hashShort(s) {
    var h = 5381; s = String(s || "");
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16).slice(0, 8);
  }
  window.addEventListener("error", function (ev) {
    track("error_uncaught_js", {
      error_type: ev.error && ev.error.name ? ev.error.name : "Error",
      error_message_hash: hashShort(ev.message)
    });
  });
  window.addEventListener("unhandledrejection", function (ev) {
    track("error_uncaught_js", {
      error_type: "UnhandledRejection",
      error_message_hash: hashShort(ev.reason && (ev.reason.message || ev.reason))
    });
  });

  // ── Public API ──────────────────────────────────────────────────────────
  window.Pluks = {
    track: track,
    captureException: captureException,
    optOut: function () { optedOut = true; persistOptOut(true); try { window.posthog && window.posthog.opt_out_capturing(); } catch (_) {} },
    optIn:  function () { optedOut = false; persistOptOut(false); try { window.posthog && window.posthog.opt_in_capturing();  } catch (_) {} },
    isOptedOut: function () { return optedOut; },
    bucket: bucket
  };
})();
