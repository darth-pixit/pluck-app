import { expect, test } from "@playwright/test";

// Regression guard for the Apple Silicon download bug: navigator.userAgent
// reports "Intel" on every Mac, so the resolver must rely on the real GPU and
// default to the Apple Silicon (_aarch64) build. Previously every Mac visitor
// — Apple Silicon included — was handed the _x64 Intel DMG and hit the
// "install Rosetta" prompt.

const RELEASE = {
  tag_name: "v0.4.5",
  assets: [
    {
      name: "Pluks_0.4.5_aarch64.dmg",
      browser_download_url: "https://example.com/Pluks_0.4.5_aarch64.dmg",
    },
    {
      name: "Pluks_0.4.5_x64.dmg",
      browser_download_url: "https://example.com/Pluks_0.4.5_x64.dmg",
    },
  ],
};

function routeRelease(page: import("@playwright/test").Page) {
  return page.route("**/api.github.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(RELEASE),
    }),
  );
}

// Force the WebGL renderer string the detection reads, independent of the
// host GPU running these tests. The renderer is passed as an argument because
// addInitScript serializes the function and cannot capture closures.
function fakeGpu(renderer: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLCanvasElement.prototype as any).getContext = function () {
    return {
      getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 37446 }),
      getParameter: (p: number) => (p === 37446 ? renderer : ""),
    };
  };
}

const UNIVERSAL_RELEASE = {
  tag_name: "v0.5.0",
  assets: [
    {
      name: "Pluks_0.5.0_universal.dmg",
      browser_download_url: "https://example.com/Pluks_0.5.0_universal.dmg",
    },
  ],
};

test.describe("Mac download architecture", () => {
  test("universal DMG is served to everyone, regardless of GPU", async ({ page }) => {
    await page.route("**/api.github.com/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(UNIVERSAL_RELEASE),
      }),
    );
    // Even when the GPU looks like an Intel Mac, the universal build wins.
    await page.addInitScript(fakeGpu, "Intel Iris Pro");
    await page.goto("/");
    await expect
      .poll(() => page.locator("#dl-mac").getAttribute("href"))
      .toContain("_universal.dmg");
  });

  test("Apple Silicon GPU gets the aarch64 DMG", async ({ page }) => {
    await routeRelease(page);
    await page.addInitScript(fakeGpu, "Apple M2");
    await page.goto("/");
    await expect
      .poll(() => page.locator("#dl-mac").getAttribute("href"))
      .toContain("_aarch64.dmg");
  });

  test("Intel GPU gets the x64 DMG", async ({ page }) => {
    await routeRelease(page);
    await page.addInitScript(fakeGpu, "Intel Iris Pro");
    await page.goto("/");
    await expect
      .poll(() => page.locator("#dl-mac").getAttribute("href"))
      .toContain("_x64.dmg");
  });

  test("undetectable GPU defaults to aarch64 (not Intel)", async ({ page }) => {
    await routeRelease(page);
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (HTMLCanvasElement.prototype as any).getContext = () => null;
    });
    await page.goto("/");
    await expect
      .poll(() => page.locator("#dl-mac").getAttribute("href"))
      .toContain("_aarch64.dmg");
  });
});
