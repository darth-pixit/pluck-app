/**
 * Pluks website interactive demo.
 * When the user selects text in #demo-text, show a "Snagged!" toast
 * and copy it to clipboard — demonstrating exactly what the app does.
 */
(function () {
  const demoText = document.getElementById("demo-text");
  const toast = document.getElementById("demo-toast");
  const toastText = document.getElementById("demo-toast-text");

  if (!demoText || !toast || !toastText) return;

  let toastTimeout;
  let demoFirstAt = 0;
  let demoSelections = 0;

  function showToast(text) {
    const preview =
      text.length > 30 ? "\u201c" + text.slice(0, 30) + "\u2026\u201d" : "\u201c" + text + "\u201d";
    toastText.textContent = "Snagged! " + preview;
    toast.classList.add("show");
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(function () {
      toast.classList.remove("show");
    }, 2400);
  }

  function handleSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;

    const selectedText = sel.toString().trim();
    if (!selectedText) return;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(selectedText).catch(function () {
        try { document.execCommand("copy"); } catch (_) {}
      });
    } else {
      try { document.execCommand("copy"); } catch (_) {}
    }

    showToast(selectedText);

    // Anonymous bucketed instrumentation — never sends the selected text.
    try {
      if (window.Pluks && window.Pluks.track) {
        if (!demoFirstAt) demoFirstAt = Date.now();
        demoSelections++;
        window.Pluks.track("demo_interacted", {
          selection_chars_bucket: window.Pluks.bucket(selectedText.length)
        });
        if (demoSelections === 3) {
          window.Pluks.track("demo_completed", {
            time_to_complete_ms: Date.now() - demoFirstAt
          });
        }
      }
    } catch (_) {}
  }

  document.addEventListener("mouseup", function () {
    setTimeout(handleSelection, 10);
  });
  document.addEventListener("keyup", function (e) {
    if (e.shiftKey || e.key === "Shift" || (e.key && e.key.startsWith("Arrow"))) {
      setTimeout(handleSelection, 10);
    }
  });

  // Download modal — collect email + persona before letting download proceed
  (function downloadGate() {
    const modal = document.getElementById("dl-modal");
    const closeBtn = document.getElementById("dl-modal-close");
    const form = document.getElementById("dl-form");
    const emailInput = document.getElementById("dl-email");
    const personaInput = document.getElementById("dl-persona");
    const errorEl = document.getElementById("dl-error");
    if (!modal || !form) return;

    let pendingHref = null;
    let pendingPlatform = null;

    function platformFromHref(href) {
      if (/dmg/i.test(href)) return /Intel|x64/i.test(href) ? "mac_intel" : "mac";
      if (/msi/i.test(href)) return "win";
      if (/AppImage/i.test(href)) return "linux_appimage";
      if (/\.deb/i.test(href)) return "linux_deb";
      return "unknown";
    }

    function track(event, props) {
      try { if (window.Pluks && window.Pluks.track) window.Pluks.track(event, props || {}); } catch (_) {}
    }

    function open(href, platform) {
      pendingHref = href;
      pendingPlatform = platform;
      modal.classList.add("show");
      modal.setAttribute("aria-hidden", "false");
      setTimeout(function () { emailInput && emailInput.focus(); }, 50);
      track("download_modal_opened", { platform: platform });
    }
    function close(via) {
      if (modal.classList.contains("show") && via) {
        track("download_modal_closed", { platform: pendingPlatform || "unknown", via: via });
      }
      modal.classList.remove("show");
      modal.setAttribute("aria-hidden", "true");
      pendingHref = null;
      pendingPlatform = null;
      errorEl.hidden = true;
    }

    document.querySelectorAll(".btn-download").forEach(function (a) {
      a.addEventListener("click", function (e) {
        const href = a.getAttribute("href");
        if (!href) return;
        if (sessionStorage.getItem("pluks_dl_ok") === "1") return; // already submitted this session
        e.preventDefault();
        open(href, platformFromHref(href));
      });
    });

    closeBtn && closeBtn.addEventListener("click", function () { close("close_button"); });
    modal.addEventListener("click", function (e) {
      if (e.target === modal) close("backdrop");
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && modal.classList.contains("show")) close("escape");
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      const email = (emailInput.value || "").trim();
      const persona = personaInput.value;
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!emailOk || !persona) {
        errorEl.textContent = !emailOk ? "Please enter a valid work email." : "Please pick a persona.";
        errorEl.hidden = false;
        track("download_form_invalid", { reason: !emailOk ? "invalid_email" : "missing_persona" });
        return;
      }
      try {
        const leads = JSON.parse(localStorage.getItem("pluks_leads") || "[]");
        leads.push({ email: email, persona: persona, ts: new Date().toISOString() });
        localStorage.setItem("pluks_leads", JSON.stringify(leads));
      } catch (_) {}
      sessionStorage.setItem("pluks_dl_ok", "1");

      // Persona is a low-cardinality category (no PII). Email is NEVER sent.
      track("download_form_submitted", { platform: pendingPlatform || "unknown", persona: persona });

      const href = pendingHref;
      close();
      if (href) window.location.href = href;
    });
  })();

  // Highlight OS-specific download CTA
  (function highlightPlatformCard() {
    const ua = navigator.userAgent.toLowerCase();
    let cardId;
    if (ua.includes("mac os x") || ua.includes("macintosh")) {
      cardId = "card-mac";
    } else if (ua.includes("windows")) {
      cardId = "card-win";
    } else {
      cardId = "card-linux";
    }
    const card = document.getElementById(cardId);
    if (card) {
      card.style.borderColor = "rgba(252,76,2,.5)";
      card.style.boxShadow = "0 0 0 1px rgba(252,76,2,.15), 0 8px 32px rgba(252,76,2,.15)";
      const btn = card.querySelector(".btn-download");
      if (btn) {
        btn.textContent = "\u2193 Download for " + (cardId === "card-mac" ? "macOS" : cardId === "card-win" ? "Windows" : "Linux");
        btn.style.fontSize = "14px";
      }
    }
  })();
})();
