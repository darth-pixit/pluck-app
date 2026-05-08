import { expect, test } from "@playwright/test";

test.describe("Interactive demo", () => {
  test("selecting demo text shows the 'Snagged!' toast", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");

    // Use the DOM Selection API directly — the demo binds on selectionchange/
    // mouseup. We then dispatch a mouseup so the demo handler runs.
    await page.evaluate(() => {
      const el = document.getElementById("demo-text")!;
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    const toast = page.locator("#demo-toast");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/Snagged/);
  });

  test("toast disappears after the configured duration", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      const el = document.getElementById("demo-text")!;
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    const toast = page.locator("#demo-toast");
    await expect(toast).toHaveClass(/show/);
    // The CSS class is removed after ~2400 ms.
    await expect(toast).not.toHaveClass(/show/, { timeout: 5_000 });
  });
});
