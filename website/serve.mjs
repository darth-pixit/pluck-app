// Tiny static server for tests. We don't pull in vite/serve to keep the
// website a no-build artifact: the deployed site is just the raw files in
// this directory served by GitHub Pages.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 0);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let p = url.pathname;
  if (p === "/" || p === "") p = "/index.html";
  const fp = path.join(ROOT, p.replace(/^\//, ""));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  res.setHeader("content-type", TYPES[path.extname(fp)] || "text/plain");
  res.end(fs.readFileSync(fp));
});

server.listen(PORT, "127.0.0.1", () => {
  const port = server.address().port;
  console.log(`pluks website test server: http://127.0.0.1:${port}`);
});
