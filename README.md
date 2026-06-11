# Pluks — Select to Copy

**Select any text. It's already copied.** No Ctrl+C. No right-click. Just highlight, and Pluks does the rest.

Free, tiny, and open-source. Available as a native desktop app for macOS, Windows, and Linux.

Website: [pluks.app](https://pluks.app)

## Repository layout

| Path | What's in it |
| --- | --- |
| [`app/`](./app) | Desktop app — Tauri 2 + React 19 + TypeScript + Vite. Includes the system-tray history panel, preferences, activation tour, and updater. |
| [`website/`](./website) | Marketing site served at [pluks.app](https://pluks.app). Static HTML/CSS/JS with an interactive demo. |
| [`scripts/`](./scripts) | Release signing setup, analytics digest, and lead-handling helpers. |
| [`tests/`](./tests) | Manual release regression test plan. |
| [`.github/workflows/`](./.github/workflows) | CI: tests, release builds, website deploy, daily analytics digest. |

## Features

- **Auto-copy on selection** — highlight text anywhere and it's on your clipboard.
- **Searchable history** — last 200 clips, kept locally.
- **Local-first** — clipboard data never leaves your device.
- **Anonymous, opt-out telemetry** — usage stats help us improve; turn it off in preferences.
- **Cross-platform** — macOS, Windows, Linux.

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

See repository for license details.
