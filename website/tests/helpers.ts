import type { Page } from "@playwright/test";

// Route stubs shared by the download specs. Two jobs: keep every test
// deterministic + offline, and keep CI traffic out of the production
// analytics / lead-capture endpoints (analytics.js ships a real PostHog key;
// see the analytics-truth-audit skill for why synthetic traffic is poison).
// Apply to EVERY page — including pages from manually created contexts, which
// do not inherit routes registered on the default fixture.
export async function stubExternal(page: Page): Promise<void> {
  await page.route("**/script.google.com/**", (route) => route.fulfill({ status: 200, body: "ok" }));
  await page.route("https://e.pluks.app/**", (route) => route.fulfill({ status: 200, body: "{}" }));
  await page.route("https://*.ingest.sentry.io/**", (route) =>
    route.fulfill({ status: 200, body: "{}" }),
  );
}

export async function routeRelease(page: Page, release: unknown): Promise<void> {
  await page.route("**/api.github.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(release),
    }),
  );
}
