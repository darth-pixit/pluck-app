<p align="center">
  <img src=".github/demo.gif" alt="Pluks demo — select any text and it's instantly copied to your clipboard" width="720">
</p>

<h1 align="center">Pluks — Select text. It's already copied.</h1>

<p align="center">
  Auto-copies any text you select — no Ctrl+C, no right-click. Free, tiny, open source.
</p>

<p align="center">
  <a href="https://github.com/darth-pixit/pluck-app/releases/latest"><img src="https://img.shields.io/badge/macOS-Download-000000?logo=apple&logoColor=white" alt="Download for macOS"></a>
  <a href="https://github.com/darth-pixit/pluck-app/releases/latest"><img src="https://img.shields.io/badge/Windows-Download-0078D4" alt="Download for Windows"></a>
  <a href="https://github.com/darth-pixit/pluck-app/releases/latest"><img src="https://img.shields.io/badge/Linux-Download-FCC624?logo=linux&logoColor=black" alt="Download for Linux"></a>
  <br>
  <a href="https://github.com/darth-pixit/pluck-app/releases/latest"><img src="https://img.shields.io/github/v/release/darth-pixit/pluck-app?color=FC4C02" alt="Latest release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-2ea44f" alt="MIT license"></a>
  <a href="https://pluks.app"><img src="https://img.shields.io/badge/website-pluks.app-FC4C02" alt="pluks.app"></a>
</p>

## Features

- **Auto-copy on selection** — highlight text anywhere and it's on your clipboard.
- **Searchable history** — last 200 clips, kept locally.
- **Local-first** — clipboard data never leaves your device.
- **Anonymous, opt-out telemetry** — usage stats help us improve; turn it off in preferences.
- **Cross-platform** — macOS, Windows, Linux.

## Repository layout

| Path | What's in it |
| --- | --- |
| [`app/`](./app) | Desktop app — Tauri 2 + React 19 + TypeScript + Vite. Includes the system-tray history panel, preferences, activation tour, and updater. |
| [`extension/`](./extension) | Browser extension (Chrome, Manifest V3) — select-to-copy in the browser with popup history. |
| [`website/`](./website) | Marketing site served at [pluks.app](https://pluks.app). Static HTML/CSS/JS with an interactive demo. |
| [`scripts/`](./scripts) | Release signing setup, analytics digest, and lead-handling helpers. |
| [`tests/`](./tests) | Manual release regression test plan. |
| [`.github/workflows/`](./.github/workflows) | CI: tests, release builds, website deploy, daily analytics digest. |

## Getting started

### Desktop app

```bash
cd app
npm install
npm run tauri dev      # dev build with hot reload
npm run build          # production build
npm test               # vitest unit tests
```

### Website

```bash
cd website
npm install
node serve.mjs         # local preview
npm test               # playwright tests
```

## Privacy

Pluks stores clipboard history locally and never transmits it. Optional anonymous product analytics (PostHog) and crash reports (Sentry) can be disabled from desktop preferences. See [`website/privacy.html`](./website/privacy.html) for the full policy.

## License

[MIT](./LICENSE)
