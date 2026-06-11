# Pluks — Select to Copy, Long-press to Paste

**Select any text. It's already copied. Press and hold anywhere — it's pasted.** No Ctrl+C, no Ctrl+V, no right-click. Two gestures, one matched pair: highlight to copy, long-press to paste it back into whatever you're working in.

Free, tiny, and open-source. Available as a browser extension and a native desktop app for macOS, Windows, and Linux.

Website: [pluks.app](https://pluks.app) · Current desktop release: **v0.5.1** ([changelog](./CHANGELOG.md))

## Repository layout

| Path | What's in it |
| --- | --- |
| [`app/`](./app) | Desktop app — Tauri 2 + React 19 + TypeScript + Vite, with a Rust core (selection capture, history, paste). Includes the system-tray history panel, the adaptive nudge engine, smart-paste detectors, preferences with macOS permission management, the activation tour, and the auto-updater. |
| [`extension/`](./extension) | Browser extension (Manifest V3, Chrome/Firefox). Content script that auto-copies selected text, with a searchable 100-item history popup. |
| [`website/`](./website) | Marketing site served at [pluks.app](https://pluks.app). Static HTML/CSS/JS with an interactive demo and a feedback widget. |
| [`scripts/`](./scripts) | Release signing setup, the DMG install-window background generator, the daily analytics digest, and lead-handling helpers. |
| [`tests/`](./tests) | Manual release regression test plan. |
| [`.github/workflows/`](./.github/workflows) | CI: tests, release builds, website deploy, daily analytics digest. |

## Features

- **Select to copy** — highlight text anywhere and it's on your clipboard before you even lift your finger.
- **Long-press to paste** *(desktop)* — the other half of the gesture pair. Press and hold still for ~350 ms anywhere on screen and Pluks silently pastes your most recent clip into the app you're already in — no Cmd+V, no focus stolen, just a whisper-quiet confirmation pill near your cursor. Movement always wins, so a normal click-drag to select never triggers a paste. (⌃⇧V opens the full history overlay for everything else.)
- **Smart paste** — Pluks recognizes URLs, emails, hex colors, and JSON in your history and offers handy paste-format variants.
- **Adaptive nudges** *(desktop)* — gentle "✦ Copied" affirmations while each habit forms, a corrective hint when you reach for Ctrl+C out of muscle memory, and a one-time discovery nudge that teaches the long-press paste gesture once you've copied enough to be ready for it. Both sides taper off as you adopt them, and there's a kill-switch.
- **Searchable history** — last 100 clips, kept locally.
- **Local-first** — clipboard data never leaves your device.
- **Auto-updating desktop app** — signed releases install in place; macOS ships a single universal2 build for Apple Silicon and Intel.
- **Guided setup** *(macOS)* — request and re-grant Accessibility and Input Monitoring permissions right from Preferences.
- **Anonymous, opt-out telemetry** — usage stats help us improve; turn it off in the popup or preferences.
- **Cross-platform** — macOS, Windows, Linux, plus Chrome- and Firefox-based browsers.

## Getting started

### Desktop app

```bash
cd app
npm install
npm run tauri dev      # dev build with hot reload
npm run build          # production build (tsc + vite)
npm test               # vitest unit tests
npm run e2e            # WebdriverIO end-to-end tests
```

### Browser extension

Load `extension/` as an unpacked extension in your browser (Chrome: `chrome://extensions` → Developer mode → Load unpacked; Firefox: `about:debugging` → Load Temporary Add-on, pick `manifest.json`).

```bash
cd extension
npm install
npm test               # playwright tests
```

Pre-built packages: `pluks-extension.xpi` (Firefox) and `pluks-extension.zip` (Chrome) at the repo root.

### Website

```bash
cd website
npm install
node serve.mjs         # local preview
npm test               # playwright tests
```

## Privacy

Pluks stores clipboard history locally and never transmits it. Optional anonymous product analytics (PostHog) and crash reports (Sentry) can be disabled from the extension popup or desktop preferences. The website feedback widget sends your message via a pre-filled email — the message text is never sent to analytics. See [`website/privacy.html`](./website/privacy.html) for the full policy.

## Releases & changelog

Notable changes are tracked in [`CHANGELOG.md`](./CHANGELOG.md), and tagged binaries live on the [GitHub releases page](https://github.com/darth-pixit/pluck-app/releases). Please update the changelog and this README's release line with every major release.

## License

See repository for license details.
