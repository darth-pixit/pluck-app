import { expect, test } from "./fixtures";

test.describe("Popup", () => {
  test("renders empty state when storage is empty", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.locator(".empty")).toContainText(/No history yet/);
  });

  test("renders history entries from storage", async ({ context, extensionId }) => {
    const [worker] = context.serviceWorkers();
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        history: [
          { text: "alpha entry", ts: Date.now() - 5000 },
          { text: "beta entry", ts: Date.now() - 3000 },
        ],
      });
    });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.locator(".item-text").first()).toHaveText("alpha entry");
    await expect(page.locator(".item-text").nth(1)).toHaveText("beta entry");
  });

  test("search filter narrows the list", async ({ context, extensionId }) => {
    const [worker] = context.serviceWorkers();
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        history: [
          { text: "apple pie", ts: Date.now() },
          { text: "banana bread", ts: Date.now() },
          { text: "apricot tart", ts: Date.now() },
        ],
      });
    });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.fill("#searchInput", "ap");
    await expect(page.locator(".item-text")).toHaveCount(2);
    await page.fill("#searchInput", "banana");
    await expect(page.locator(".item-text")).toHaveCount(1);
    await page.fill("#searchInput", "");
    await expect(page.locator(".item-text")).toHaveCount(3);
  });

  test("clicking a row writes to clipboard and flashes ✓", async ({ context, extensionId }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const [worker] = context.serviceWorkers();
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        history: [{ text: "the copied phrase", ts: Date.now() }],
      });
    });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.click(".item");
    await expect(page.locator(".copy-hint").first()).toHaveText("✓");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe("the copied phrase");
  });

  test("Clear all empties the list and storage", async ({ context, extensionId }) => {
    const [worker] = context.serviceWorkers();
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        history: [{ text: "to be cleared", ts: Date.now() }],
      });
    });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.click("#clearBtn");
    await expect(page.locator(".empty")).toBeVisible();
    const remaining = await worker.evaluate(async () => {
      const { history = [] } = await (chrome.storage.local.get("history") as Promise<{ history?: unknown[] }>);
      return history.length;
    });
    expect(remaining).toBe(0);
  });

  test("opt-out toggle persists across popup re-opens", async ({ context, extensionId }) => {
    const page1 = await context.newPage();
    await page1.goto(`chrome-extension://${extensionId}/popup.html`);
    await page1.check("#optOut");
    await page1.close();
    const page2 = await context.newPage();
    await page2.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page2.locator("#optOut")).toBeChecked();
  });
});
