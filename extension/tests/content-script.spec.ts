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

  test("selecting text saves a history entry to chrome.storage.local", async ({ context, baseURL, serviceWorker }) => {
    const page = await context.newPage();
    await page.goto(baseURL);
    await selectTextById(page, "prose");
    const history = await serviceWorker.evaluate(async () => {
      const { history = [] } = await (chrome.storage.local.get("history") as Promise<{ history?: Array<{ text: string; ts: number }> }>);
      return history;
    });
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].text).toContain("quick brown fox");
  });

  test("selecting the same text twice deduplicates", async ({ context, baseURL, serviceWorker }) => {
    const page = await context.newPage();
    await page.goto(baseURL);
    await selectTextById(page, "prose");
    await selectTextById(page, "prose");
    const history = await serviceWorker.evaluate(async () => {
      const { history = [] } = await (chrome.storage.local.get("history") as Promise<{ history?: Array<{ text: string }> }>);
      return history;
    });
    const matchCount = history.filter((i: { text: string }) =>
      i.text.includes("quick brown fox"),
    ).length;
    expect(matchCount).toBe(1);
  });

  test("single-click on a select-all input captures the field value", async ({ context, baseURL, serviceWorker }) => {
    const page = await context.newPage();
    await page.goto(baseURL);
    // Real click — fires mousedown/mouseup and the page's onclick=this.select().
    await page.locator("#share-url").click();
    await page.waitForTimeout(300);
    await expect(page.locator("#__pluks_toast")).toBeVisible();
    const history = await serviceWorker.evaluate(async () => {
      const { history = [] } = await (chrome.storage.local.get("history") as Promise<{ history?: Array<{ text: string }> }>);
      return history;
    });
    expect(history[0].text).toBe("https://example.com/share/abc123");
  });

  test("single-click on a plain input does not copy", async ({ context, baseURL }) => {
    const page = await context.newPage();
    await page.goto(baseURL);
    // No onclick=select(), so a single click only positions the caret —
    // selectionStart === selectionEnd, nothing to capture.
    await page.locator("#plain-input").click();
    await page.waitForTimeout(300);
    await expect(page.locator("#__pluks_toast")).not.toBeVisible();
  });

  test("single-click on an input nested inside a shadow root captures the value", async ({ context, baseURL, serviceWorker }) => {
    const page = await context.newPage();
    await page.goto(baseURL);
    // Click the inner input via piercing locator. mouseup target re-targets to
    // the shadow host (<my-shadow-input>); the content script must walk the
    // composedPath to find the real <input>.
    await page.locator("my-shadow-input").locator("#shadow-input").click();
    await page.waitForTimeout(300);
    const history = await serviceWorker.evaluate(async () => {
      const { history = [] } = await (chrome.storage.local.get("history") as Promise<{ history?: Array<{ text: string }> }>);
      return history;
    });
    expect(history[0].text).toBe("shadow dom selected text");
  });

  test("Cmd/Ctrl+A inside a textarea is captured even without a mouse gesture", async ({ context, baseURL, serviceWorker }) => {
    const page = await context.newPage();
    await page.goto(baseURL);
    await page.locator("#kb-textarea").focus();
    // Real keystroke — no mousedown/mouseup at all. Pre-fix this would be
    // invisible to Pluks because capture only ran from mouseup.
    await page.keyboard.press("ControlOrMeta+a");
    await page.waitForTimeout(300);
    const history = await serviceWorker.evaluate(async () => {
      const { history = [] } = await (chrome.storage.local.get("history") as Promise<{ history?: Array<{ text: string }> }>);
      return history;
    });
    expect(history[0].text).toBe("keyboard selectable text in a textarea");
  });

  test("programmatic .select() (no user gesture) is captured via the select event", async ({ context, baseURL, serviceWorker }) => {
    const page = await context.newPage();
    await page.goto(baseURL);
    // Trigger a JS .select() via a button. The select event fires on the input
    // even though the user never interacted with it directly.
    await page.locator("#programmatic-select").click();
    await page.waitForTimeout(400);
    const history = await serviceWorker.evaluate(async () => {
      const { history = [] } = await (chrome.storage.local.get("history") as Promise<{ history?: Array<{ text: string }> }>);
      return history;
    });
    expect(history.some((i) => i.text === "https://example.com/share/abc123")).toBe(true);
  });

  test("selections inside iframes are captured (all_frames injection)", async ({ context, baseURL, serviceWorker }) => {
    const page = await context.newPage();
    await page.goto(baseURL);
    const frame = page.frameLocator("#iframe-frame");
    // Drag-select inside the iframe by dispatching a synthetic gesture in its
    // document. With all_frames the content script runs in the iframe and
    // captures this; without it, nothing lands.
    await page.locator("#iframe-frame").contentFrame().locator("#iframe-prose").waitFor();
    await frame.locator("body").evaluate(() => {
      const el = document.getElementById("iframe-prose")!;
      const range = document.createRange();
      range.selectNodeContents(el);
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(range);
      const downEvt = new MouseEvent("mousedown", { button: 0, clientX: 0, clientY: 0, bubbles: true });
      const upEvt = new MouseEvent("mouseup", { button: 0, clientX: 100, clientY: 100, bubbles: true });
      document.dispatchEvent(downEvt);
      document.dispatchEvent(upEvt);
    });
    await page.waitForTimeout(400);
    const history = await serviceWorker.evaluate(async () => {
      const { history = [] } = await (chrome.storage.local.get("history") as Promise<{ history?: Array<{ text: string }> }>);
      return history;
    });
    expect(history.some((i) => i.text.includes("iframe content selectable here"))).toBe(true);
  });

  test("history is saved even when clipboard.writeText rejects", async ({ context, baseURL, serviceWorker }) => {
    const page = await context.newPage();
    await page.goto(baseURL);
    // The no-clipboard iframe is served with `Permissions-Policy:
    // clipboard-write=()`, so the content script's navigator.clipboard.writeText
    // genuinely rejects there. Pre-fix this dropped the entry; post-fix the
    // SELECTION message is sent before the clipboard call, so history persists.
    const frame = page.frameLocator("#no-clipboard-iframe");
    await frame.locator("#nc-prose").waitFor();
    const ncFrame = page.frames().find((f) => /iframe-no-clipboard\.html$/.test(f.url()))!;
    expect(ncFrame).toBeTruthy();
    // Sanity check: confirm clipboard-write is actually denied in this frame.
    const clipboardDenied = await ncFrame.evaluate(async () => {
      try {
        await navigator.clipboard.writeText("probe");
        return false;
      } catch {
        return true;
      }
    });
    expect(clipboardDenied).toBe(true);
    await ncFrame.evaluate(() => {
      const el = document.getElementById("nc-prose")!;
      const range = document.createRange();
      range.selectNodeContents(el);
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(range);
      const downEvt = new MouseEvent("mousedown", { button: 0, clientX: 0, clientY: 0, bubbles: true });
      const upEvt = new MouseEvent("mouseup", { button: 0, clientX: 100, clientY: 100, bubbles: true });
      document.dispatchEvent(downEvt);
      document.dispatchEvent(upEvt);
    });
    await page.waitForTimeout(400);
    const history = await serviceWorker.evaluate(async () => {
      const { history = [] } = await (chrome.storage.local.get("history") as Promise<{ history?: Array<{ text: string }> }>);
      return history;
    });
    expect(history.some((i) => i.text.includes("no clipboard available here"))).toBe(true);
  });

  test("history is capped at 100 entries", async ({ context, baseURL, serviceWorker }) => {
    const page = await context.newPage();
    await page.goto(baseURL);
    // Pre-load 100 entries directly via the service worker.
    await serviceWorker.evaluate(async () => {
      const items = Array.from({ length: 100 }, (_, i) => ({
        text: `pre-existing-${String(i).padStart(3, "0")}`,
        ts: Date.now() - (100 - i) * 1000,
      }));
      await chrome.storage.local.set({ history: items });
    });
    await selectTextById(page, "prose");
    const len = await serviceWorker.evaluate(async () => {
      const { history = [] } = await (chrome.storage.local.get("history") as Promise<{ history?: unknown[] }>);
      return history.length;
    });
    expect(len).toBe(100);
  });
});
