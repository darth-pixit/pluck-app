// Pluks popup script

const listEl = document.getElementById("list");
const searchEl = document.getElementById("searchInput");
const clearBtn = document.getElementById("clearBtn");

let allHistory = [];

function timeAgo(ts) {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function render(items) {
  listEl.innerHTML = "";

  if (!items.length) {
    listEl.innerHTML = `
      <div class="empty">
        <span class="icon">⚡</span>
        <p>No history yet.<br/>Select text on any page<br/>and it'll appear here.</p>
      </div>
    `;
    return;
  }

  items.forEach((item, idx) => {
    const div = document.createElement("div");
    div.className = "item";
    div.dataset.idx = idx;

    const preview = item.text.replace(/\s+/g, " ").trim();

    div.innerHTML = `
      <div class="item-text" title="${escapeAttr(item.text)}">${escapeHtml(preview)}</div>
      <span class="copy-hint">Copy</span>
      <span class="item-time">${timeAgo(item.ts)}</span>
    `;

    div.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(item.text);
        div.classList.add("copied-flash");
        div.querySelector(".copy-hint").textContent = "✓";
        setTimeout(() => {
          div.classList.remove("copied-flash");
          div.querySelector(".copy-hint").textContent = "Copy";
        }, 800);
      } catch {
        // Fallback: write via execCommand (older browsers)
        const ta = document.createElement("textarea");
        ta.value = item.text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
    });

    listEl.appendChild(div);
  });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(str) {
  return str.replace(/"/g, "&quot;");
}

function applyFilter(query) {
  if (!query) {
    render(allHistory);
    return;
  }
  const q = query.toLowerCase();
  render(allHistory.filter((i) => i.text.toLowerCase().includes(q)));
}

// Load history on open
chrome.storage.local.get("history", ({ history = [] }) => {
  allHistory = history;
  render(allHistory);
});

// Live search
searchEl.addEventListener("input", () => applyFilter(searchEl.value));

// Keyboard: Escape closes popup
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.close();
});

// Clear all
clearBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ history: [] });
  allHistory = [];
  render([]);
});
