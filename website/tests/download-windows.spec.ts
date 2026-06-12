import { expect, test } from "@playwright/test";
import { routeRelease, stubExternal } from "./helpers";

// The Windows download card ships labeled Beta: the build is CI-validated
// (installer, launch, clipboard capture — .github/workflows/windows-smoke.yml)
// but hasn't had the Mac app's months of daily human use. These tests pin the
// behaviors the card depends on: MSI asset resolution from the latest release,
// the visible Beta label, the email-gate modal shared with every other
// download CTA, and the Windows-visitor CTA retargeting in demo.js.

const RELEASE = {
  tag_name: "v0.7.0",
  assets: [
    {
      name: "Pluks_0.7.0_universal.dmg",
      browser_download_url: "https://example.com/Pluks_0.7.0_universal.dmg",
    },
    {
      name: "Pluks_0.7.0_x64_en-US.msi",
      browser_download_url: "https://example.com/Pluks_0.7.0_x64_en-US.msi",
    },
  ],
};

test.describe("Windows download card", () => {
  test.beforeEach(async ({ page }) => {
    await routeRelease(page, RELEASE);
    await stubExternal(page);
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

  test("a Windows visitor gets the hero and nav CTAs retargeted at the MSI", async ({ browser }) => {
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    });
    const winPage = await ctx.newPage();
    await routeRelease(winPage, RELEASE);
    await stubExternal(winPage);
    await winPage.goto("/");
    // Hero CTA: relabeled, retargeted at the MSI.
    await expect(winPage.locator("#dl-mac")).toContainText(/windows/i);
    await expect
      .poll(() => winPage.locator("#dl-mac").getAttribute("href"))
      .toContain("_x64_en-US.msi");
    await expect(winPage.locator("nav .nav-cta")).toContainText(/windows/i);
    // The Mac card's own button stays a Mac download.
    await expect
      .poll(() => winPage.locator("#dl-mac-card").getAttribute("href"))
      .toContain("_universal.dmg");
    await ctx.close();
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
