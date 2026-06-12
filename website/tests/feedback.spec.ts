import { expect, test } from "./helpers";

test.describe("Feedback widget", () => {
  test.beforeEach(async ({ page }) => {
    // Keep tests deterministic + offline by stubbing the external endpoints
    // the page touches on load.
    await page.route("**/api.github.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ assets: [] }) }),
    );
    await page.route("https://e.pluks.app/**", (route) => route.fulfill({ status: 200, body: "{}" }));
    await page.route("https://*.ingest.sentry.io/**", (route) => route.fulfill({ status: 200, body: "{}" }));
  });

  test("launcher is visible and opens the panel", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#feedback-fab")).toBeVisible();
    await expect(page.locator("#feedback-panel")).toBeHidden();
    await page.click("#feedback-fab");
    await expect(page.locator("#feedback-panel")).toHaveClass(/show/);
    await expect(page.locator("#feedback-message")).toBeFocused();
  });

  test("panel exposes the contact email as a mailto link", async ({ page }) => {
    await page.goto("/");
    await page.click("#feedback-fab");
    const mailto = page.locator(
      '#feedback-panel a[href="mailto:parth.dixit@alumni.iitd.ac.in"]',
    );
    await expect(mailto.first()).toBeVisible();
  });

  test("submitting an empty message shows an error", async ({ page }) => {
    await page.goto("/");
    await page.click("#feedback-fab");
    await page.click(".feedback-submit");
    await expect(page.locator("#feedback-error")).toBeVisible();
    await expect(page.locator("#feedback-error")).toContainText(/message/i);
  });

  test("an invalid email is rejected", async ({ page }) => {
    await page.goto("/");
    await page.click("#feedback-fab");
    await page.fill("#feedback-message", "Love the app!");
    await page.fill("#feedback-email", "not-an-email");
    await page.click(".feedback-submit");
    await expect(page.locator("#feedback-error")).toBeVisible();
    await expect(page.locator("#feedback-error")).toContainText(/email/i);
  });

  test("a valid message hands off to mailto and shows the confirmation", async ({ page }) => {
    await page.goto("/");
    await page.click("#feedback-fab");
    await page.fill("#feedback-message", "Found a bug on Linux");
    await page.fill("#feedback-email", "alice@example.com");
    await page.click(".feedback-submit");

    // Setting location.href to a mailto: URL hands off to the OS mail client
    // without navigating the document, so the page stays put and shows the
    // confirmation state.
    await expect(page.locator("#feedback-success")).toBeVisible();
    await expect(page.locator("#feedback-form")).toBeHidden();
  });

  test("Escape closes the panel", async ({ page }) => {
    await page.goto("/");
    await page.click("#feedback-fab");
    await expect(page.locator("#feedback-panel")).toHaveClass(/show/);
    await page.keyboard.press("Escape");
    await expect(page.locator("#feedback-panel")).not.toHaveClass(/show/);
  });

  test("× close button closes the panel", async ({ page }) => {
    await page.goto("/");
    await page.click("#feedback-fab");
    await page.click("#feedback-close");
    await expect(page.locator("#feedback-panel")).not.toHaveClass(/show/);
  });
});
