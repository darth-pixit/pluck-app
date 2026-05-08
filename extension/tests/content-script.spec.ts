import { expect, test } from "./fixtures";

async function selectTextById(page: import("@playwright/test").Page, id: string) {
  await page.evaluate((sel) => {
    const el = document.getElementById(sel);
    if (!el) throw new Error("missing " + sel);
    const range = document.createRange();
    range.selectNodeContents(el);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(range);
    // Fire a fake mousedown→mouseup so the content script's drag-detect path
    // sees movement (>4px) and triggers the capture.
    const downEvt = new MouseEvent("mousedown", { button: 0, clientX: 0, clientY: 0, bubbles: true });
    const upEvt = new MouseEvent("mouseup", { button: 0, clientX: 100, clientY: 100, bubbles: true });
    document.dispatchEvent(downEvt);
    document.dispatchEvent(upEvt);
  }, id);
  // Give the 30 ms timeout in content.js room to fire, plus chrome.runtime
  // round-trip to the SW.
  await page.waitForTimeout(300);
}

test.describe("Content script", () => {
  test("content script is active (toast element appears after capture)", async ({ context, baseURL }) => {
    // We can't read the content script's __pluks_injected flag from the page
    // main world (isolated worlds don't share globals). Instead, we observe
    // a side effect: dispatching a select+mouseup gesture should make the
    // toast div appear in the DOM via the content script's writeText path.
    const page = await context.newPage();
    await page.goto(baseURL);
    await selectTextById(page, "prose");
    await expect(page.locator("#__pluks_toast")).toBeVisible();
  });

  test("drag-selecting text shows the 'Snagged!' toast", async ({ context, baseURL }) => {
    const page = await context.newPage();
    await page.goto(baseURL);
    await selectTextById(page, "prose");
    const toastText = await page.locator("#__pluks_toast").innerText();
    expect(toastText).toContain("Snagged");
  });

  test("selecting text saves a history entry to chrome.storage.local", async ({ context, baseURL }) => {
    const page = await context.newPage();
    await page.goto(baseURL);
    await selectTextById(page, "prose");
    // Read storage from the service worker.
    const [worker] = context.serviceWorkers();
    const history = await worker.evaluate(async () => {
      const { history = [] } = await (chrome.storage.local.get("history") as Promise<{ history?: Array<{ text: string; ts: number }> }>);
      return history;
    });
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].text).toContain("quick brown fox");
  });

  test("selecting the same text twice deduplicates", async ({ context, baseURL }) => {
    const page = await context.newPage();
    await page.goto(baseURL);
    await selectTextById(page, "prose");
    await selectTextById(page, "prose");
    const [worker] = context.serviceWorkers();
    const history = await worker.evaluate(async () => {
      const { history = [] } = await (chrome.storage.local.get("history") as Promise<{ history?: Array<{ text: string }> }>);
      return history;
    });
    const matchCount = history.filter((i: { text: string }) =>
      i.text.includes("quick brown fox"),
    ).length;
    expect(matchCount).toBe(1);
  });

  test("history is capped at 100 entries", async ({ context, baseURL }) => {
    const page = await context.newPage();
    await page.goto(baseURL);
    // Pre-load 100 entries directly via the service worker.
    const [worker] = context.serviceWorkers();
    await worker.evaluate(async () => {
      const items = Array.from({ length: 100 }, (_, i) => ({
        text: `pre-existing-${String(i).padStart(3, "0")}`,
        ts: Date.now() - (100 - i) * 1000,
      }));
      await chrome.storage.local.set({ history: items });
    });
    await selectTextById(page, "prose");
    const len = await worker.evaluate(async () => {
      const { history = [] } = await (chrome.storage.local.get("history") as Promise<{ history?: unknown[] }>);
      return history.length;
    });
    expect(len).toBe(100);
  });
});
