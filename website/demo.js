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

  document.addEventListener("mouseup", function (e) {
    // Only react to selections inside the demo card
    const card = document.getElementById("demo-card");
    if (!card) return;

    // Small delay to let the browser register the selection
    setTimeout(function () {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;

      const selectedText = sel.toString().trim();
      if (!selectedText) return;

      // Is the selection inside our demo card?
      const anchor = sel.anchorNode;
      if (!card.contains(anchor)) return;

      // Copy to clipboard
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(selectedText).catch(function () {
          // Fallback: execCommand
          try {
            document.execCommand("copy");
          } catch (_) {}
        });
      } else {
        try {
          document.execCommand("copy");
        } catch (_) {}
      }

      showToast(selectedText);
    }, 10);
  });

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
