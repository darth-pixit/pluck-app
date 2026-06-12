import { test as base, expect, type Page } from "@playwright/test";

// Route stubs shared by every spec. Two jobs: keep tests deterministic +
// offline, and keep CI traffic out of the production analytics /
// lead-capture endpoints (analytics.js ships a real PostHog key; see the
// analytics-truth-audit skill for why synthetic traffic is poison).
export async function stubExternal(page: Page): Promise<void> {
  await page.route("**/script.google.com/**", (route) => route.fulfill({ status: 200, body: "ok" }));
  await page.route("https://e.pluks.app/**", (route) => route.fulfill({ status: 200, body: "{}" }));
  await page.route("https://*.ingest.sentry.io/**", (route) =>
    route.fulfill({ status: 200, body: "{}" }),
  );
  // The Sentry SDK is a synchronous <head> script — unstubbed, a flaky CDN
  // gates page parsing and blows test timeouts that look like regressions.
  // The ACAO header matters: index.html loads it with crossorigin="anonymous",
  // and a fulfilled response without it is rejected by the renderer's CORS
  // check (harmless today — every window.Sentry use is guarded — but the
  // stub should actually serve).
  await page.route("**/browser.sentry-cdn.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: "",
    }),
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

// Drop-in replacement for @playwright/test's `test`: every page from the
// default fixture is hermetic automatically. Pages from manually created
// contexts (browser.newContext()) do NOT inherit these routes — call
// stubExternal(page) on them explicitly.
export const test = base.extend({
  page: async ({ page }, use) => {
    await stubExternal(page);
    await use(page);
  },
});

export { expect };
