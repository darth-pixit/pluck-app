// Pluks background service worker
// Stores selection history in chrome.storage.local (max 100 entries)

const MAX_HISTORY = 100;

chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg.type !== "SELECTION" || !msg.text) return;
  saveEntry(msg.text);
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
