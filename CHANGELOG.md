# Changelog

All notable changes to Pluks are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [v0.5.0] - 2026-06-08

### Changed
- macOS: the `.dmg` now opens to a proper install window — Pluks.app sits next to
  an Applications folder shortcut with a "DRAG PLUKS TO APPLICATIONS" arrow, so
  users drag-install into `/Applications` instead of running the app from the disk
  image or Desktop. Installing into `/Applications` avoids Gatekeeper App
  Translocation, which is the usual reason the Input Monitoring / Accessibility
  panes show an empty list and force users to manually locate and add the app.

### Fixed
- Onboarding: sample clips copied during the activation tour now land in
  history. The background capture loop skips capture while the panel is visible
  (which it always is during the tour), so these clips were silently dropped and
  the user hit an empty panel right after onboarding. The tour now records them
  directly.
- macOS: ship a single universal2 `.dmg` that runs natively on both Apple
  Silicon and Intel. Apple Silicon users no longer get the "install Rosetta"
  prompt. The release now builds one `universal-apple-darwin` bundle instead of
  separate per-arch DMGs; the updater maps it to both darwin keys so existing
  installs auto-update.
- Website: the download button handed every Mac visitor the Intel DMG because
  `navigator.userAgent` reports "Intel" on all Macs. It now serves the universal
  build (and, for older releases, detects the real arch and defaults to Apple
  Silicon).

## [v0.4.5] - 2026-05-16

### Added
- Silent paste flow with a brief confirmation pill: triggering a paste no longer steals focus from the active app, and a small pill confirms the paste landed. Replaces the radial paste menu.

### Fixed
- macOS Tahoe 26.2: overlay views (nudges, confirmation pill) were sometimes invisible. Added visibility mitigations and tray diagnostics so failures are observable.
- Hold-to-discover nudge could re-fire indefinitely in long sessions.
- Duplicate paste-confirm events emitted for a single paste.

### Changed
- DEV-only visibility probes in NudgeView, RadialMenu, and the React entry point to make future overlay regressions easier to catch.
- Extension test fixtures: fix a Manifest V3 service-worker race that flaked Playwright runs.

## [v0.4.4] - 2026-05-14

- Affirmation nudge fires on every selection, with a kill-switch.
- Use `kIOHIDRequestTypeListenEvent` (0) for Input Monitoring permission checks.
- CI: bootstrap rustup from scratch on Windows runners; pin default toolchain before cargo invocations.

See the [v0.4.4 GitHub release](https://github.com/darth-pixit/pluck-app/releases/tag/v0.4.4) for binaries.

## [v0.4.3] - 2026-05-13

- Show & re-grant system permissions from Preferences.
- Auto-open SetupScreen when macOS permissions are missing.

See the [v0.4.3 GitHub release](https://github.com/darth-pixit/pluck-app/releases/tag/v0.4.3) for binaries.

## [v0.4.2] - 2026-05-13

- Actively request Accessibility & Input Monitoring permissions on macOS.

See the [v0.4.2 GitHub release](https://github.com/darth-pixit/pluck-app/releases/tag/v0.4.2) for binaries.

## [v0.4.1] - 2026-05-12

- Widen paste-watch window to 500ms for realistic motor timing.
- Fix tight spacing between update banner title and CTAs.
- Attach paste-as strip to the active history row.
- CI: raise App Rust cargo test timeout from 25 to 40 minutes for cold-cache rebuilds.

See the [v0.4.1 GitHub release](https://github.com/darth-pixit/pluck-app/releases/tag/v0.4.1) for binaries.

## [v0.4.0] - 2026-05-12

- Long-press to reveal a radial paste menu.
- Restore select-to-replace via Cmd+V watch window.

See the [v0.4.0 GitHub release](https://github.com/darth-pixit/pluck-app/releases/tag/v0.4.0) for binaries.

## [v0.3.0] and earlier

See the [GitHub releases page](https://github.com/darth-pixit/pluck-app/releases) for binaries and release-level notes.
