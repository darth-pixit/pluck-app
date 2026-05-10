import { test as base, chromium, type BrowserContext } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Playwright fixtures for extension tests:
 *  - Persistent Chromium with the unpacked extension loaded.
 *  - A localhost HTTP server (the manifest only matches http(s)://, never
 *    file://, so we serve test pages over a real http origin).
 */

function startTestServer() {
  const root = __dirname;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let p = url.pathname;
    if (p === "/" || p === "") p = "/test-page.html";
    const fp = path.join(root, p.replace(/^\//, ""));
    if (!fp.startsWith(root) || !fs.existsSync(fp)) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const ext = path.extname(fp);
    const ct = ext === ".html" ? "text/html" : ext === ".js" ? "text/javascript" : "text/plain";
    res.setHeader("content-type", ct + "; charset=utf-8");
    // Deny clipboard-write for the no-clipboard iframe fixture so the content
    // script's navigator.clipboard.writeText actually rejects — the only way
    // to genuinely test the "history saved even when clipboard fails" path
    // (overriding navigator.clipboard from page.evaluate doesn't reach the
    // content script's isolated world).
    if (p === "/iframe-no-clipboard.html") {
      res.setHeader("permissions-policy", "clipboard-write=()");
    }
    res.end(fs.readFileSync(fp));
  });
  return new Promise<{ server: http.Server; baseURL: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, baseURL: `http://127.0.0.1:${port}` });
    });
  });
}

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  baseURL: string;
}>({
  // eslint-disable-next-line no-empty-pattern
  baseURL: async ({}, use) => {
    const { server, baseURL } = await startTestServer();
    await use(baseURL);
    server.close();
  },
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const extPath = path.resolve(__dirname, "..");
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pluks-ext-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: false,
      args: [
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    await use(context);
    await context.close();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  },
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker");
    const id = worker.url().split("/")[2];
    await use(id);
  },
});

export const expect = test.expect;
