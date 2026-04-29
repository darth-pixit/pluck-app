// Pluks content script — runs in every tab
// Monitors mouse releases, reads selection, copies to clipboard

(function () {
  "use strict";

  // Avoid injecting twice (e.g. in iframes)
  if (window.__pluks_injected) return;
  window.__pluks_injected = true;

  let pressX = 0;
  let pressY = 0;
  let lastRelease = 0;
  let clickCount = 0;
  let toastTimeout = null;

  // ── Toast UI ──────────────────────────────────────────────────────────────

  function createToast() {
    const el = document.createElement("div");
    el.id = "__pluks_toast";
    el.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      background: #1a1a1a;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      font-weight: 500;
      padding: 8px 14px;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
      pointer-events: none;
      opacity: 0;
      transform: translateY(8px);
      transition: opacity 0.15s ease, transform 0.15s ease;
      display: flex;
      align-items: center;
      gap: 8px;
      max-width: 280px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    `;
    document.documentElement.appendChild(el);
    return el;
  }

  function showToast(text) {
    let toast = document.getElementById("__pluks_toast");
    if (!toast) toast = createToast();

    const preview = text.length > 40 ? text.slice(0, 40) + "…" : text;
    toast.innerHTML = `
      <span style="color:#FC4C02;font-size:15px;">⚡</span>
      <span>Snagged! <span style="opacity:0.6;font-weight:400;">${escapeHtml(preview)}</span></span>
    `;

    // Reset animation
    toast.style.transition = "none";
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px)";

    // Force reflow then animate in
    void toast.offsetWidth;
    toast.style.transition = "opacity 0.15s ease, transform 0.15s ease";
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";

    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(8px)";
    }, 2000);
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── Content-kind classifier ───────────────────────────────────────────────
  // Returns a coarse label only ("url" | "json" | "email" | "color" | "code"
  // | "text"). The label is the ONLY thing derived from the selection that
  // ever leaves the device; the original text is never sent.

  var URL_RE   = /^(https?:\/\/|ftp:\/\/)\S+$/i;
  var WWW_RE   = /^www\.[^\s.]+\.\S+$/i;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var HEX_RE   = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  // Cap JSON.parse — selections can be megabytes of log output.
  var JSON_PARSE_MAX = 500000;

  function looksLikeCode(s) {
    var lines = s.split("\n");
    if (lines.length < 2) return false;
    var codey = 0;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (/^(\s{2,}|\t)/.test(l) ||
          /[;{}]\s*$/.test(l) ||
          /^\s*(import|from|function|const|let|var|class|def|return|if|for|while|public|private)\b/.test(l)) {
        codey++;
      }
    }
    return codey / lines.length >= 0.4;
  }

  function classify(text) {
    var trimmed = text.trim();
    if (!trimmed) return "text";
    if (HEX_RE.test(trimmed)) return "color";
    if (URL_RE.test(trimmed) || WWW_RE.test(trimmed)) return "url";
    if (EMAIL_RE.test(trimmed)) return "email";
    var first = trimmed[0], last = trimmed[trimmed.length - 1];
    if (trimmed.length <= JSON_PARSE_MAX &&
        ((first === "{" && last === "}") || (first === "[" && last === "]"))) {
      try { JSON.parse(trimmed); return "json"; } catch (_) {}
    }
    if (looksLikeCode(text)) return "code";
    return "text";
  }

  // ── Mouse tracking ────────────────────────────────────────────────────────

  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    pressX = e.clientX;
    pressY = e.clientY;

    const now = Date.now();
    if (now - lastRelease < 500) {
      clickCount++;
    } else {
      clickCount = 1;
    }
  }, true);

  document.addEventListener("mouseup", (e) => {
    if (e.button !== 0) return;

    const dx = Math.abs(e.clientX - pressX);
    const dy = Math.abs(e.clientY - pressY);
    const isDrag = dx > 4 || dy > 4;
    const isMultiClick = clickCount >= 2;

    lastRelease = Date.now();

    if (!isDrag && !isMultiClick) return;

    // Small delay to let the browser finalise the selection
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel) return;
      const text = sel.toString().trim();
      if (!text) return;

      // Copy to clipboard
      navigator.clipboard.writeText(text).then(() => {
        showToast(text);
        // Notify background to save to history
        chrome.runtime.sendMessage({ type: "SELECTION", text });
        if (isMultiClick) clickCount = 0;

        // Anonymous instrumentation. Never sends `text`. Bucketed length only.
        try {
          if (window.Pluks) {
            window.Pluks.track("selection_captured", {
              char_count_bucket: window.Pluks.bucket(text.length),
              was_drag: isDrag,
              was_multi_click: isMultiClick,
              scheme: location.protocol.replace(":", ""),
              content_kind: classify(text)
            });
            // Sample toast event ~25% to keep volume down.
            if (Math.random() < 0.25) {
              window.Pluks.track("toast_shown", {
                char_count_bucket: window.Pluks.bucket(text.length)
              });
            }
          }
        } catch (_) {}
      }).catch((err) => {
        // Clipboard write blocked (e.g. some cross-origin frames)
        try {
          if (window.Pluks) {
            var reason = "unknown";
            if (err && /not allowed|denied|permission/i.test(err.message || "")) reason = "permission";
            else if (window.top !== window) reason = "cross_origin";
            window.Pluks.track("selection_capture_failed", { reason: reason });
          }
        } catch (_) {}
      });
    }, 30);
  }, true);

})();
