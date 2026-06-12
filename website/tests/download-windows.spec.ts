import { expect, test } from "@playwright/test";

// The Windows download card ships labeled Beta: the build is CI-validated
// (installer, launch, clipboard capture — .github/workflows/windows-smoke.yml)
// but hasn't had the Mac app's months of daily human use. These tests pin the
// three behaviors the card depends on: MSI asset resolution from the latest
// release, the visible Beta label, and the email-gate modal shared with every
// other download CTA.

const RELEASE = {
  tag_name: "v0.5.2",
  assets: [
    {
      name: "Pluks_0.5.2_universal.dmg",
      browser_download_url: "https://example.com/Pluks_0.5.2_universal.dmg",
    },
    {
      name: "Pluks_0.5.2_x64_en-US.msi",
      browser_download_url: "https://example.com/Pluks_0.5.2_x64_en-US.msi",
    },
  ],
};

test.describe("Windows download card", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api.github.com/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(RELEASE),
      }),
    );
    // Keep tests deterministic + offline (same set as download-modal.spec.ts).
    await page.route("**/script.google.com/**", (route) => route.fulfill({ status: 200, body: "ok" }));
    await page.route("https://e.pluks.app/**", (route) =>
      route.fulfill({ status: 200, body: "{}" }),
    );
    await page.route("https://*.ingest.sentry.io/**", (route) =>
      route.fulfill({ status: 200, body: "{}" }),
    );
  });

  test("the Windows button resolves to the MSI asset", async ({ page }) => {
    await page.goto("/");
    await expect
      .poll(() => page.locator("#dl-win").getAttribute("href"))
      .toContain("_x64_en-US.msi");
  });

  test("the Mac card still resolves to the DMG alongside the MSI", async ({ page }) => {
    await page.goto("/");
    await expect
      .poll(() => page.locator("#dl-mac-card").getAttribute("href"))
      .toContain("_universal.dmg");
  });

  test("the Windows card is visibly labeled Beta", async ({ page }) => {
    await page.goto("/");
    const card = page.locator("#card-win");
    await expect(card).toBeVisible();
    await expect(card.locator(".pill")).toHaveText(/beta/i);
  });

  test("clicking the Windows download opens the email-gate modal", async ({ page }) => {
    await page.goto("/");
    // Neutralize the href so the post-capture state can't navigate away
    // (same pattern as download-modal.spec.ts).
    await page.evaluate(() => {
      const a = document.getElementById("dl-win") as HTMLAnchorElement | null;
      if (a) a.setAttribute("href", "javascript:void(0)");
    });
    await page.click("#dl-win");
    await expect(page.locator("#dl-modal")).toHaveClass(/show/);
  });
});
