// Pluks background service worker
// Stores selection history in chrome.storage.local (max 100 entries) and
// emits anonymous lifecycle telemetry via Pluks analytics.
importScripts("config.js", "analytics.js");

const MAX_HISTORY = 100;

// One-time on install/update.
chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await self.Pluks.ensureIdentity();
    if (details.reason === "install") {
      self.Pluks.track("app_installed", { install_source: /firefox/i.test(navigator.userAgent) ? "firefox" : "chrome" });
    } else if (details.reason === "update") {
      self.Pluks.track("app_updated", {
        from_version: details.previousVersion || "unknown",
        to_version: chrome.runtime.getManifest().version
      });
    }
  } catch (e) { try { self.Pluks.captureException(e, "onInstalled"); } catch (_) {} }
});

// Cold-start of the service worker.
chrome.runtime.onStartup.addListener(() => {
  try { self.Pluks.track("app_launched", { cold_start: true }); } catch (_) {}
});

chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  try {
    if (msg.type !== "SELECTION" || !msg.text) return;
    saveEntry(msg.text);
  } catch (e) {
    try { self.Pluks.captureException(e, "onMessage"); } catch (_) {}
  }
});

async function saveEntry(text) {
  const { history = [] } = await chrome.storage.local.get("history");

  // Deduplicate: remove existing entry with same text
  const filtered = history.filter((item) => item.text !== text);

  // Prepend newest entry
  filtered.unshift({ text, ts: Date.now() });

  // Trim to max
  const trimmed = filtered.slice(0, MAX_HISTORY);

  await chrome.storage.local.set({ history: trimmed });
}
