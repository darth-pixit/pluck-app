/**
 * Pluks feedback widget.
 *
 * A small launcher pinned to the bottom-right of the page. Clicking it opens a
 * panel with a short form (optional email + message). On submit we hand the
 * message off to the user's mail client via a pre-filled mailto: to
 * parth.dixit@alumni.iitd.ac.in — no backend required, works on the static
 * site, and the address is also shown as a plain link for anyone who'd rather
 * email directly.
 *
 * Analytics: fires anonymous, content-free `feedback_widget_opened` and
 * `feedback_submitted` events (the message text is NEVER sent — only a coarse
 * length bucket and whether a reply email was supplied).
 */
(function () {
  "use strict";

  var CONTACT_EMAIL = "parth.dixit@alumni.iitd.ac.in";

  var fab     = document.getElementById("feedback-fab");
  var panel   = document.getElementById("feedback-panel");
  var closeBtn = document.getElementById("feedback-close");
  var form    = document.getElementById("feedback-form");
  var emailEl = document.getElementById("feedback-email");
  var msgEl   = document.getElementById("feedback-message");
  var errorEl = document.getElementById("feedback-error");
  var successEl = document.getElementById("feedback-success");

  if (!fab || !panel || !form) return;

  function track(event, props) {
    try { if (window.Pluks && window.Pluks.track) window.Pluks.track(event, props || {}); } catch (_) {}
  }

  function isOpen() {
    return panel.classList.contains("show");
  }

  function open() {
    panel.hidden = false;
    // Next frame so the transition runs from the hidden state.
    requestAnimationFrame(function () { panel.classList.add("show"); });
    fab.setAttribute("aria-expanded", "true");
    setTimeout(function () { msgEl && msgEl.focus(); }, 60);
    track("feedback_widget_opened", {});
  }

  function close() {
    panel.classList.remove("show");
    fab.setAttribute("aria-expanded", "false");
    // Wait for the fade-out before hiding from the a11y tree.
    setTimeout(function () { if (!isOpen()) panel.hidden = true; }, 200);
  }

  function toggle() { isOpen() ? close() : open(); }

  function resetForm() {
    form.hidden = false;
    successEl.hidden = true;
    errorEl.hidden = true;
    form.reset();
  }

  fab.addEventListener("click", toggle);
  closeBtn && closeBtn.addEventListener("click", close);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isOpen()) { close(); fab.focus(); }
  });

  // Click outside the panel (and not on the launcher) closes it.
  document.addEventListener("click", function (e) {
    if (!isOpen()) return;
    if (panel.contains(e.target) || fab.contains(e.target)) return;
    close();
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var email   = (emailEl.value || "").trim();
    var message = (msgEl.value || "").trim();

    if (!message) {
      errorEl.textContent = "Please write a short message first.";
      errorEl.hidden = false;
      msgEl.focus();
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errorEl.textContent = "That email doesn't look right — leave it blank if you'd prefer.";
      errorEl.hidden = false;
      emailEl.focus();
      return;
    }
    errorEl.hidden = true;

    // Build a pre-filled email to the maintainer. The reply-to address lives
    // in the body because mailto:?reply-to isn't honoured by most clients.
    var subject = "Pluks feedback";
    var bodyLines = [message, "", "—"];
    if (email) bodyLines.push("Reply to: " + email);
    bodyLines.push("Sent from " + location.href);
    var mailto =
      "mailto:" + CONTACT_EMAIL +
      "?subject=" + encodeURIComponent(subject) +
      "&body=" + encodeURIComponent(bodyLines.join("\n"));

    // Anonymous, content-free instrumentation — never sends the message text.
    track("feedback_submitted", {
      has_email: email ? "yes" : "no",
      message_chars_bucket: window.Pluks && window.Pluks.bucket
        ? window.Pluks.bucket(message.length)
        : "unknown"
    });

    // Hand off to the mail client and show the confirmation state.
    form.hidden = true;
    successEl.hidden = false;
    window.location.href = mailto;
  });

  // Reset back to the form whenever the panel is re-opened after a send.
  fab.addEventListener("click", function () {
    if (isOpen() && !form.hidden) return;
    if (!successEl.hidden) resetForm();
  });
})();
