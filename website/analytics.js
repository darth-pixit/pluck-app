/**
 * Pluks website analytics — bare-fetch PostHog client + Sentry.
 *
 * We bypass posthog-js entirely because v1.372.10 sends batched events as
 * a bare JSON array with no `api_key` field, which our project rejects
 * with 401. Hand-rolling the wire format is the same approach used by
 * extension/analytics.js, which has worked reliably for months.
 *
 * What this file does:
 *   - Fires $pageview on load and $pageleave on unload, with the
 *     properties the PostHog Web Analytics dashboard expects (so the
 *     "$pageview" and "scroll depth" health checks pass).
 *   - Tracks scroll-depth maximum and ships it with $pageleave.
 *   - Captures CTA / nav / download-modal events with a strict
 *     property whitelist — no clipboard content, no URLs, no PII.
 *   - Honors navigator.doNotTrack and ?opt_out=1.
 */
(function () {
  "use strict";

  var POSTHOG_KEY  = "phc_rAzNboDZLDXo4ePmSUaHGPF7aCbinStawno6HYGTgEte";
  // Use our managed reverse proxy. Routes through pluks.app so ad blockers
  // can't filter by `*.posthog.com`. Falls back fine if DNS ever breaks —
  // the project still accepts requests on `https://us.i.posthog.com`.
  var POSTHOG_HOST = "https://e.pluks.app";
  var SENTRY_DSN   = "https://PLACEHOLDER_REPLACE_AT_DEPLOY@o0.ingest.sentry.io/0";
  var RELEASE      = "pluks-web@2026.04";
  var LIB_VERSION  = "pluks-web-1.0.0";

  function isRealKey(s) { return !!s && s.indexOf("PLACEHOLDER") === -1; }
  if (!isRealKey(POSTHOG_KEY)) console.warn("[pluks] PostHog disabled — placeholder key in use");
  if (!isRealKey(SENTRY_DSN))  console.warn("[pluks] Sentry disabled — placeholder DSN in use");

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

  // Whitelist of custom event property keys. PostHog's $-prefixed standard
  // properties for $pageview/$pageleave bypass this list.
  var SCHEMA = {
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

  // Exact-match anchors so a key like `email_hash` isn't flagged.
  var DENY_RX = /^(text|content|url|selection|email|path|host|hostname|page_title|tab_url|secret|token|password)$/i;

  function bucket(n) {
    if (n <= 10) return "1-10";
    if (n <= 100) return "11-100";
    if (n <= 1000) return "101-1000";
    if (n <= 10000) return "1001-10000";
    return "10000+";
  }

  function detectBrowser() {
    var ua = navigator.userAgent || "";
    if (/Firefox\//.test(ua))           return "Firefox";
    if (/Edg\//.test(ua))               return "Microsoft Edge";
    if (/OPR\//.test(ua))               return "Opera";
    if (/Chrome\//.test(ua))            return "Chrome";
    if (/Safari\//.test(ua))            return "Safari";
    return "Unknown";
  }

  function detectOs() {
    var ua = navigator.userAgent || "";
    if (/Mac OS X/.test(ua))   return "Mac OS X";
    if (/Windows/.test(ua))    return "Windows";
    if (/Linux/.test(ua))      return "Linux";
    if (/Android/.test(ua))    return "Android";
    if (/(iPhone|iPad)/.test(ua)) return "iOS";
    return "Unknown";
  }

  function standardProps() {
    var referrer = document.referrer || "";
    var referringDomain = "";
    try { referringDomain = referrer ? new URL(referrer).hostname : ""; } catch (_) {}
    return {
      $current_url:      location.href,
      $host:             location.host,
      $pathname:         location.pathname || "/",
      $referrer:         referrer,
      $referring_domain: referringDomain,
      $screen_height:    window.screen ? window.screen.height : 0,
      $screen_width:     window.screen ? window.screen.width  : 0,
      $viewport_height:  window.innerHeight,
      $viewport_width:   window.innerWidth,
      $browser:          detectBrowser(),
      $os:               detectOs(),
      $lib:              "web",
      $lib_version:      LIB_VERSION,
      $browser_language: navigator.language || "unknown",
      // Tells PostHog this event came via our managed reverse proxy.
      // posthog-js sets this automatically when api_host is non-default;
      // we have to set it manually since we're hand-rolling the wire format.
      // Without it, the "Reverse proxy" health check stays red even though
      // events are arriving on the proxy hostname.
      $lib_custom_api_host: POSTHOG_HOST,
      surface:           "web",
      release:           RELEASE
    };
  }

  function whitelistProps(event, props) {
    var allowed = SCHEMA[event];
    if (!allowed) return null; // unknown custom event — refuse to send
    var out = {};
    for (var i = 0; i < allowed.length; i++) {
      var k = allowed[i];
      if (props && k in props && !DENY_RX.test(k)) out[k] = props[k];
    }
    return out;
  }

  var optedOut = readOptOut();
  var _anonId  = anonId();

  // ── PostHog: bare fetch to /i/v0/e/ ─────────────────────────────────────
  function sendEvent(event, properties, useBeacon) {
    if (optedOut || !isRealKey(POSTHOG_KEY)) return;
    var body = {
      api_key:     POSTHOG_KEY,
      event:       event,
      distinct_id: _anonId,
      properties:  properties,
      timestamp:   new Date().toISOString()
    };
    var url     = POSTHOG_HOST + "/i/v0/e/";
    var payload = JSON.stringify(body);
    try {
      if (useBeacon && navigator.sendBeacon) {
        // sendBeacon doesn't accept custom Content-Type, but PostHog
        // sniffs the body and accepts JSON regardless.
        var blob = new Blob([payload], { type: "application/json" });
        navigator.sendBeacon(url, blob);
        return;
      }
      fetch(url, {
        method:      "POST",
        headers:     { "Content-Type": "application/json" },
        body:        payload,
        keepalive:   true,
        credentials: "omit"
      }).catch(function () {});
    } catch (_) { /* swallow */ }
  }

  // Public custom-event tracker (used by demo.js etc.)
  function track(event, props) {
    var clean = whitelistProps(event, props || {});
    if (!clean) return;
    var merged = Object.assign({}, standardProps(), clean);
    sendEvent(event, merged, false);
  }

  // ── $pageview + $pageleave (drives the Web Analytics dashboard) ─────────
  // Track both top-of-viewport ("scroll") and bottom-of-viewport ("content")
  // positions so PostHog's scroll-depth heatmap can distinguish "user saw
  // the bottom of the page" (content) from "user scrolled all the way down"
  // (scroll). Property names match what posthog-js's ScrollManager emits.
  var _scroll = {
    lastScrollY:    0,
    maxScrollY:     0,
    lastContentY:   0,
    maxContentY:    0,
    maxScrollHeight: 0   // scrollable distance (scrollHeight - innerHeight)
  };
  function recordScroll() {
    var doc = document.documentElement;
    var maxScroll = Math.max(0, doc.scrollHeight - window.innerHeight);
    var y = window.scrollY || 0;
    var contentY = y + window.innerHeight;
    _scroll.lastScrollY  = y;
    _scroll.lastContentY = contentY;
    if (y > _scroll.maxScrollY)        _scroll.maxScrollY  = y;
    if (contentY > _scroll.maxContentY) _scroll.maxContentY = contentY;
    if (maxScroll > _scroll.maxScrollHeight) _scroll.maxScrollHeight = maxScroll;
  }
  window.addEventListener("scroll", recordScroll, { passive: true });
  // Capture the initial position too — even users who never scroll have
  // seen one viewport-worth of content.
  recordScroll();

  function firePageview() {
    sendEvent("$pageview", standardProps(), false);
  }
  function firePageleave() {
    var docHeight = Math.max(
      document.documentElement.scrollHeight,
      _scroll.maxScrollHeight + window.innerHeight
    );
    var pct = function (n, d) {
      if (d <= 0) return 1;
      var p = n / d;
      return p < 0 ? 0 : (p > 1 ? 1 : p);
    };
    var props = Object.assign({}, standardProps(), {
      $prev_pageview_pathname:               location.pathname || "/",
      $prev_pageview_last_scroll:            _scroll.lastScrollY,
      $prev_pageview_last_scroll_percentage: pct(_scroll.lastScrollY, _scroll.maxScrollHeight),
      $prev_pageview_max_scroll:             _scroll.maxScrollY,
      $prev_pageview_max_scroll_percentage:  pct(_scroll.maxScrollY,  _scroll.maxScrollHeight),
      $prev_pageview_last_content:           _scroll.lastContentY,
      $prev_pageview_last_content_percentage: pct(_scroll.lastContentY, docHeight),
      $prev_pageview_max_content:            _scroll.maxContentY,
      $prev_pageview_max_content_percentage: pct(_scroll.maxContentY,  docHeight)
    });
    sendEvent("$pageleave", props, true);
  }

  // Defer $pageview a tick so other inline scripts on this page finish first.
  setTimeout(firePageview, 0);

  // ── Core Web Vitals (LCP / CLS / FCP) ───────────────────────────────────
  // Inline PerformanceObserver-based capture so we don't pull a CDN script.
  // Values report on pagehide together with $pageleave (PostHog dashboard
  // reads $web_vitals_<METRIC>_value and $web_vitals_<METRIC>_event props).
  // INP is intentionally skipped — its measurement needs event-timing
  // bookkeeping that's not worth ~3KB of extra code for a marketing page.
  var _vitals = {};
  var VITAL_THRESHOLDS = { LCP: [2500, 4000], FCP: [1800, 3000], CLS: [0.1, 0.25] };
  function ratingFor(name, value) {
    var t = VITAL_THRESHOLDS[name];
    if (!t) return "unknown";
    if (value <= t[0]) return "good";
    if (value <= t[1]) return "needs-improvement";
    return "poor";
  }
  function recordVital(name, value) {
    _vitals[name] = { value: value, rating: ratingFor(name, value), id: name + "-" + Date.now() };
  }
  function observeVitals() {
    if (typeof PerformanceObserver !== "function") return;
    // LCP — the last largest-contentful-paint entry is the final value.
    try {
      new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        var last = entries[entries.length - 1];
        if (last && last.startTime) recordVital("LCP", last.startTime);
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch (_) {}
    // CLS — sum of all unexpected layout shifts after page load.
    try {
      var cls = 0;
      new PerformanceObserver(function (list) {
        for (var i = 0; i < list.getEntries().length; i++) {
          var e = list.getEntries()[i];
          if (!e.hadRecentInput) cls += e.value;
        }
        recordVital("CLS", cls);
      }).observe({ type: "layout-shift", buffered: true });
    } catch (_) {}
    // FCP — fires once when first-contentful-paint is observed.
    try {
      new PerformanceObserver(function (list) {
        for (var i = 0; i < list.getEntries().length; i++) {
          var e = list.getEntries()[i];
          if (e.name === "first-contentful-paint") recordVital("FCP", e.startTime);
        }
      }).observe({ type: "paint", buffered: true });
    } catch (_) {}
  }
  observeVitals();

  function fireWebVitals() {
    var names = Object.keys(_vitals);
    if (!names.length) return;
    var props = Object.assign({}, standardProps());
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      var m = _vitals[n];
      props["$web_vitals_" + n + "_value"] = m.value;
      props["$web_vitals_" + n + "_event"] = { name: n, value: m.value, rating: m.rating, id: m.id };
    }
    sendEvent("$web_vitals", props, true);
  }

  // Best-effort $pageleave + $web_vitals on tab hide and on unload.
  // visibilitychange is more reliable on mobile; pagehide covers Safari's
  // back-forward cache. Both handlers are idempotent enough for duplicate
  // fires not to matter — PostHog dedupes by `id` on the dashboard side.
  function reportEndOfSession() {
    fireWebVitals();
    firePageleave();
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") reportEndOfSession();
  });
  window.addEventListener("pagehide", reportEndOfSession);

  // ── Sentry (CDN snippet in index.html exposes window.Sentry) ────────────
  if (window.Sentry && typeof window.Sentry.init === "function" && !optedOut && isRealKey(SENTRY_DSN)) {
    try {
      window.Sentry.init({
        dsn: SENTRY_DSN,
        release: RELEASE,
        tracesSampleRate: 0,
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,
        beforeSend: function (event) {
          try {
            var s = JSON.stringify(event);
            s = s.replace(/(\/Users\/|\/home\/)[^\/"\\]+/g, "$1~");
            return JSON.parse(s);
          } catch (_) { return event; }
        }
      });
      window.Sentry.setUser({ id: _anonId });
    } catch (_) {}
  }

  function captureException(err) {
    if (optedOut) return;
    try { if (window.Sentry) window.Sentry.captureException(err); } catch (_) {}
  }

  // ── privacy_viewed (custom funnel marker on /privacy.html) ──────────────
  if (/privacy\.html?$/.test(location.pathname || "/")) {
    track("privacy_viewed", { from_path: document.referrer ? new URL(document.referrer).pathname : "" });
  }

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

  // ── Uncaught errors → mirror to PostHog as a count event ────────────────
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
    track:           track,
    captureException: captureException,
    optOut: function () { optedOut = true;  persistOptOut(true);  },
    optIn:  function () { optedOut = false; persistOptOut(false); },
    isOptedOut: function () { return optedOut; },
    bucket: bucket
  };
})();
