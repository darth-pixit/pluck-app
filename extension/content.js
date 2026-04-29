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
              scheme: location.protocol.replace(":", "")
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
