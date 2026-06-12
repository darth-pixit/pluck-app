import { expect, test } from "./helpers";

test.describe("Page render", () => {
  test("hero, stats, and Mac download CTA all render", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1.hero-headline")).toBeVisible();
    await expect(page.locator(".stats-inner")).toBeVisible();
    await expect(page.locator("#dl-mac")).toBeVisible();
    await expect(page.locator("#dl-mac")).toContainText(/Mac/i);
  });

  test("page has no JavaScript console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto("/", { waitUntil: "networkidle" });
    // Filter out errors from third-party CDNs (PostHog, Sentry) that fail to
    // load placeholder keys — those are expected in dev.
    const real = errors.filter(
      (e) =>
        !/posthog|sentry|placeholder/i.test(e) &&
        !/Failed to load resource/i.test(e),
    );
    expect(real).toEqual([]);
  });

  test("permission FAQ is collapsed by default and links to selection.rs", async ({ page }) => {
    await page.goto("/");
    const faq = page.locator("#faq-permission");
    const body = faq.locator(".faq-body");
    // "Beneath a click": the explanation must not be visible until expanded.
    await expect(body).toBeHidden();
    await faq.locator("summary").click();
    await expect(body).toBeVisible();
    await expect(body.locator("a[href*='selection.rs']")).toHaveAttribute(
      "href",
      /github\.com\/darth-pixit\/pluck-app\/blob\/main\/app\/src-tauri\/src\/selection\.rs/,
    );
  });

  test("privacy page renders", async ({ page }) => {
    await page.goto("/privacy.html");
    await expect(page.locator("body")).toContainText(/privacy/i);
  });
});
