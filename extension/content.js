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
  // Many of the new triggers below (mouseup, keyup, select, selectionchange)
  // can fire for the same selection in quick succession. Dedupe within a short
  // window so a single user gesture lands a single history entry.
  let lastCapture = { text: "", at: 0, written: false };
  let selectionDebounce = null;

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
  // Returns a coarse label. The label is the ONLY thing derived from the
  // selection that ever leaves the device; the original text is never sent.
  // Mirror of app/src/detectors.ts — keep regexes in sync.

  var URL_RE   = /^(https?:\/\/|ftp:\/\/)\S+$/i;
  var WWW_RE   = /^www\.[^\s.]+\.\S+$/i;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var HEX_RE   = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  var CODE_INDENT_RE  = /^(\s{2,}|\t)/;
  var CODE_BRACE_RE   = /[;{}]\s*$/;
  var CODE_KEYWORD_RE = /^\s*(import|from|function|const|let|var|class|def|return|if|for|while|public|private)\b/;

  // Synchronous bounds — classify runs on the page's main thread inside the
  // mouseup handler. Keep work small even on adversarial multi-MB selections.
  var CLASSIFY_MAX = 100000;
  var JSON_PARSE_MAX = 65536;
  var CODE_LINE_MAX  = 2000;

  function looksLikeCode(s) {
    var lines = s.split("\n", CODE_LINE_MAX + 1);
    if (lines.length < 2) return false;
    var sample = Math.min(lines.length, CODE_LINE_MAX);
    var codey = 0;
    for (var i = 0; i < sample; i++) {
      var l = lines[i];
      if (CODE_INDENT_RE.test(l) || CODE_BRACE_RE.test(l) || CODE_KEYWORD_RE.test(l)) {
        codey++;
      }
    }
    return codey / sample >= 0.4;
  }

  function classify(trimmed) {
    if (!trimmed) return "text";
    if (trimmed.length > CLASSIFY_MAX) return "text";
    if (HEX_RE.test(trimmed)) return "color";
    if (URL_RE.test(trimmed) || WWW_RE.test(trimmed)) return "url";
    if (EMAIL_RE.test(trimmed)) return "email";
    var first = trimmed[0], last = trimmed[trimmed.length - 1];
    if (trimmed.length <= JSON_PARSE_MAX &&
        ((first === "{" && last === "}") || (first === "[" && last === "]"))) {
      // Swallow silently — V8's parse-error message embeds input bytes; never
      // forward this exception (e.g. captureException) or the selection leaks.
      try { JSON.parse(trimmed); return "json"; } catch (_) {}
    }
    if (looksLikeCode(trimmed)) return "code";
    return "text";
  }

  // ── Mouse tracking ────────────────────────────────────────────────────────

  // Walk through shadow roots when the page uses custom elements (Material Web,
  // Lit/Stencil, etc.). document.activeElement reports the shadow host; the
  // real focused control lives at host.shadowRoot.activeElement (recursively).
  function deepActiveElement() {
    let el = null;
    try { el = document.activeElement; } catch (_) { return null; }
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    }
    return el;
  }

  // mouseup re-targets to the shadow host, so e.target.tagName is the custom
  // element, not the inner INPUT. Walk the composed path to find the real
  // field the user clicked on.
  function fieldFromEvent(e) {
    const path = (typeof e.composedPath === "function") ? e.composedPath() : [];
    for (let i = 0; i < path.length; i++) {
      const n = path[i];
      if (n && n.nodeType === 1 && (n.tagName === "INPUT" || n.tagName === "TEXTAREA")) {
        return n;
      }
    }
    return e.target || null;
  }

  // Read the current selection inside an <input>/<textarea>. Such fields don't
  // contribute to window.getSelection(); they expose selection via their own
  // selectionStart/End pair. Wrapped in try/catch because some Firefox input
  // types (number, email, tel, url) throw on selectionStart access.
  function getFieldSelection(el) {
    if (!el) return "";
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA") return "";
    // Never read masked credentials, even if the user explicitly selected them.
    if (tag === "INPUT" && (el.type || "").toLowerCase() === "password") return "";
    try {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      if (start == null || end == null || end <= start) return "";
      return el.value.substring(start, end);
    } catch (_) {
      // Firefox throws on number/email/tel/url. We can't read the range, so
      // best-effort fall back to the full value when this element is the
      // currently focused control — that's the only state in which a user
      // could have just produced a selection inside it.
      try {
        if (deepActiveElement() === el && el.value) return el.value;
      } catch (__) {}
      return "";
    }
  }

  // Read whatever the user currently has selected, preferring a field if one
  // is the focused/clicked target.
  function readSelection(fieldHint) {
    let text = "";
    let isFieldSelect = false;
    if (fieldHint) {
      text = getFieldSelection(fieldHint).trim();
      isFieldSelect = !!text;
    }
    if (!text) {
      try {
        const sel = window.getSelection();
        if (sel) text = sel.toString().trim();
      } catch (_) {}
    }
    return { text: text, isFieldSelect: isFieldSelect };
  }

  // Synchronous fallback for navigator.clipboard.writeText. Required because
  // the async Clipboard API requires document.hasFocus() and an unexpired user
  // activation — both of which pages like WhatsApp Web routinely invalidate
  // between mouseup and the .then() callback (the in-page formatting popup
  // shifts focus the instant a selection lands). execCommand('copy') is laxer
  // and runs synchronously, so it tends to succeed when writeText doesn't.
  function copyViaExecCommand(text) {
    // Save the user's visible selection so the temp textarea below doesn't
    // visibly clobber it for the duration of the copy.
    let saved = [];
    let activeRestore = null;
    try {
      const sel = window.getSelection();
      if (sel) {
        for (let i = 0; i < sel.rangeCount; i++) saved.push(sel.getRangeAt(i).cloneRange());
      }
      // INPUT/TEXTAREA selections aren't part of window.getSelection(); remember
      // them via selectionStart/End on the focused element if applicable.
      const ae = deepActiveElement();
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) {
        try {
          const s = ae.selectionStart, e = ae.selectionEnd, dir = ae.selectionDirection;
          if (s != null && e != null) activeRestore = { el: ae, s: s, e: e, dir: dir };
        } catch (_) {}
      }
    } catch (_) {}

    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;";
    document.documentElement.appendChild(ta);
    let ok = false;
    try {
      ta.select();
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand("copy");
    } catch (_) {}
    ta.remove();

    try {
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        saved.forEach((r) => { try { sel.addRange(r); } catch (_) {} });
      }
      if (activeRestore) {
        try {
          activeRestore.el.focus();
          activeRestore.el.setSelectionRange(activeRestore.s, activeRestore.e, activeRestore.dir);
        } catch (_) {}
      }
    } catch (_) {}
    return ok;
  }

  // Single funnel for every capture path (mouseup, keyup, select, selectionchange).
  // History is saved unconditionally; clipboard is best-effort. This is a change
  // from the original behaviour where clipboard failure silently dropped the
  // entry — the popup should always reflect what the user selected.
  function commitCapture(text, opts) {
    const now = Date.now();
    const isDup = (text === lastCapture.text && now - lastCapture.at < 1500);
    // If the last write for this exact text already landed on the clipboard,
    // a near-duplicate event is just noise — drop it. But if the previous
    // write failed, let this duplicate event retry the clipboard write
    // (without re-announcing it to history). This is the fix for the case
    // where the first writeText silently rejects (page lost focus, e.g.
    // WhatsApp Web's selection toolbar grabbing focus) and the user is then
    // stuck pasting a stale clipboard value.
    if (isDup && lastCapture.written) return;

    if (!isDup) {
      try { chrome.runtime.sendMessage({ type: "SELECTION", text: text }); } catch (_) {}
    }
    lastCapture = { text: text, at: now, written: false };

    const trackSuccess = () => {
      try {
        if (window.Pluks) {
          window.Pluks.track("selection_captured", {
            char_count_bucket: window.Pluks.bucket(text.length),
            was_drag: !!(opts && opts.isDrag),
            was_multi_click: !!(opts && opts.isMultiClick),
            was_field_select: !!(opts && opts.isFieldSelect),
            source: (opts && opts.source) || "mouseup",
            scheme: location.protocol.replace(":", ""),
            content_kind: classify(text)
          });
          if (Math.random() < 0.25) {
            window.Pluks.track("toast_shown", {
              char_count_bucket: window.Pluks.bucket(text.length)
            });
          }
        }
      } catch (_) {}
    };

    const onWritten = () => {
      if (lastCapture.text === text) lastCapture.written = true;
      showToast(text);
      trackSuccess();
    };

    navigator.clipboard.writeText(text).then(onWritten).catch((err) => {
      // Synchronous fallback before reporting failure. Works even when the
      // async API rejects because focus moved away in the meantime.
      if (copyViaExecCommand(text)) {
        onWritten();
        return;
      }
      try {
        if (window.Pluks) {
          var reason = "unknown";
          if (err && /not allowed|denied|permission/i.test(err.message || "")) reason = "permission";
          else if (window.top !== window) reason = "cross_origin";
          window.Pluks.track("selection_capture_failed", { reason: reason });
        }
      } catch (_) {}
    });
  }

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
    // composedPath() finds the inner INPUT/TEXTAREA even when the page wraps
    // it in a custom element (Material Web, Lit, Stencil, etc.) — without
    // this, e.target is the shadow host and isField is wrongly false.
    const target = fieldFromEvent(e);
    const tag = target && target.tagName;
    const isField = tag === "INPUT" || tag === "TEXTAREA";

    lastRelease = Date.now();

    // Drag and multi-click are explicit selection gestures. A single click on a
    // text field is also captured: pages routinely select-all on focus (URL
    // share boxes, address-bar-style inputs) and the user expects that
    // highlighted text to land on the clipboard like any other selection. The
    // synchronous selection check inside the timeout filters out clicks that
    // merely position the cursor.
    if (!isDrag && !isMultiClick && !isField) return;

    // Small delay to let the browser finalise the selection
    setTimeout(() => {
      const r = readSelection(isField ? target : null);
      if (!r.text) return;
      commitCapture(r.text, {
        isDrag: isDrag,
        isMultiClick: isMultiClick,
        isFieldSelect: r.isFieldSelect,
        source: "mouseup"
      });
      if (isMultiClick) clickCount = 0;
    }, 30);
  }, true);

  // Keyboard-driven selections (Shift+arrows/Home/End/PageUp/PageDown, Cmd/Ctrl+A)
  // never produce a mouseup, so they were previously invisible to Pluks.
  document.addEventListener("keyup", (e) => {
    const k = e.key;
    const selectAll = (e.ctrlKey || e.metaKey) && (k === "a" || k === "A");
    const shiftNav = e.shiftKey && (
      k === "ArrowLeft" || k === "ArrowRight" ||
      k === "ArrowUp" || k === "ArrowDown" ||
      k === "Home" || k === "End" ||
      k === "PageUp" || k === "PageDown"
    );
    if (!selectAll && !shiftNav) return;

    setTimeout(() => {
      const ae = deepActiveElement();
      const isField = !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");
      const r = readSelection(isField ? ae : null);
      if (!r.text) return;
      commitCapture(r.text, {
        isDrag: false,
        isMultiClick: false,
        isFieldSelect: r.isFieldSelect,
        source: "keyboard"
      });
    }, 0);
  }, true);

  // Native `select` event fires on inputs/textareas for any selection change
  // inside them — covers context-menu "Select all", the page calling .select()
  // programmatically, and double/triple-click-to-select inside fields.
  document.addEventListener("select", (e) => {
    const t = e.target;
    if (!t || (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA")) return;
    const text = getFieldSelection(t).trim();
    if (!text) return;
    commitCapture(text, {
      isDrag: false,
      isMultiClick: false,
      isFieldSelect: true,
      source: "select_event"
    });
  }, true);

  // Catch-all for anything else: context-menu "Select all" on regular page
  // text, contentEditable single-click-select-all behaviour, programmatic
  // Range manipulation, etc. Heavily debounced and skipped right after a
  // mouseup so the dedicated handlers above stay authoritative.
  document.addEventListener("selectionchange", () => {
    clearTimeout(selectionDebounce);
    selectionDebounce = setTimeout(() => {
      if (Date.now() - lastRelease < 200) return;
      const ae = deepActiveElement();
      const isField = !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");
      const r = readSelection(isField ? ae : null);
      if (!r.text) return;
      commitCapture(r.text, {
        isDrag: false,
        isMultiClick: false,
        isFieldSelect: r.isFieldSelect,
        source: "selectionchange"
      });
    }, 350);
  });

})();
