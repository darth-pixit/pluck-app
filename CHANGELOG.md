# Changelog

All notable changes to Pluks are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [v0.7.1] - 2026-06-12

Hardening follow-up to the launch release. The first three fixes were merged
~10 minutes after v0.7.0 was cut and missed that train.

### Fixed
- **Privacy: the clipboard-read retry could capture a concealed secret.**
  v0.7.0's poller retries a failed clipboard read after 50 ms — but the
  likeliest reason a read fails is that another process is mid-write, quite
  possibly a password manager writing a concealed clip. The retry now re-runs
  the concealed-content check before the second read, and is skipped entirely
  on platforms without a clipboard change token (on Linux it was adding a
  50 ms sleep and a doubled read to every tick a screenshot sat on the
  clipboard).
- **A transient settings-read failure can no longer corrupt your settings.**
  If reading settings failed at startup, the in-memory fallback (random id,
  everything opted out) could later be written to disk verbatim by toggling
  any preference — permanently rotating the anonymous analytics id and
  overwriting real opt-out choices. Preference changes now recover the real
  on-disk record before persisting, and stay in-memory-only if it remains
  unreachable. The fallback keeps analytics OFF (fail-closed).
- A clip whose history write failed (e.g. the database was briefly locked) is
  now stashed and retried until it lands, instead of being silently dropped.

### Added
- **Single-instance guard.** Launching Pluks while it's already running no
  longer spawns a second copy (two capture pipelines double-recorded every
  clip into the same history). The second launch surfaces the history panel
  of the running instance instead.
- **Tray creation retries.** If the tray icon can't register — typically
  autostart winning the race against explorer.exe at login — Pluks now
  retries with backoff (5s…80s) instead of running invisibly forever with no
  quit path.

### Changed
- CI: the Windows toolchain bootstrap is one composite action instead of four
  drifting copies; the smoke harness's DB queries live in one script instead
  of four inline one-liners; smoke diagnostics are collected once and printed
  from the same set, so the job log and the artifact can't drift.
- Website analytics: iPhone/iPad visitors are no longer counted as
  "Mac OS X" (iOS UAs contain "like Mac OS X"; iPadOS 13+ ships a desktop
  Macintosh UA), and Android is no longer counted as "Linux".

## [v0.7.0] - 2026-06-12

First CI-validated Windows build, shipped as **Beta**. Supersedes v0.6.0's
Windows installer, which was published before the fixes below and carries the
capture stall and lethal-logging bugs on Windows.

### Fixed
- **Long-press paste now pastes what you just copied — even right after a
  manual Ctrl+C / Cmd+C.** v0.6.0's clipboard watcher records manual copies on
  a half-second tick, but long-press fires after a 350 ms hold and pasted the
  most-recent *history* row. Copying and immediately holding could therefore
  paste the previous clip instead — and worse, overwrite the clipboard with it,
  so the fresh copy never reached history and was lost. Long-press now checks
  the clipboard first: a copy the watcher hasn't recorded yet is banked into
  history and pasted as-is, without touching the clipboard. This also means
  long-press works on a fresh copy even when history is still empty.
  Concealed content (password managers) is still never read; those holds fall
  back to the most-recent history clip as before.

### Added (Windows launch readiness)
- **Windows runtime validation in CI** (`.github/workflows/windows-smoke.yml`):
  every run builds the real MSI, installs it silently on a `windows-latest`
  runner, launches the installed binary, asserts it survives 30 s, and proves
  the capture pipeline end-to-end — a clipboard write must land in `pluck.db`
  history, twice. Diagnostics (app stderr, panic log, MSI verbose log, WER
  dumps, event log) upload on every run. This is the first time the Windows
  build was ever executed anywhere; the website's Beta label reflects exactly
  what this harness does and doesn't prove.
- **`cargo test` on Windows** (`app-rust-windows` job): the Win32 clipboard
  primitives now actually execute in CI — sequence-number advance, the KeePass
  `ExcludeClipboardContentFromMonitorProcessing` marker,
  `CanIncludeInClipboardHistory` 0/1 (both branches), arboard roundtrip, and
  tolerant cursor / foreground-PID contracts.
- Website: download section restored with a Windows card labeled **Beta**
  (honest copy, MSI auto-resolution, email-gate modal). Windows visitors get
  the nav + hero CTAs retargeted at the MSI. Platform claims swept for honesty
  across the site, privacy policy, FAQ, and README.

### Fixed (found by the new Windows harness)
- **Capture could die with the logger.** `eprintln!` panics when the stderr
  write fails (e.g. stderr is a pipe whose reader went away — any launcher
  that closes stderr can cause this). One failed diagnostic write took down
  the clipboard poller, and the panic hook's own `eprintln!` then aborted the
  whole app before writing `pluks-panic.log`. All diagnostics now go through
  a best-effort `elog!` macro that can never panic, and the panic hook
  persists its log file *before* printing.
- **Tray failure no longer kills the app.** Tray registration
  (`Shell_NotifyIcon` on Windows) can fail when no shell is available —
  explorer.exe crashing/restarting, headless sessions. That error used to
  abort setup and exit; capture and the global shortcut now survive it.
- **History panel is forced hidden at startup** when permissions are granted.
  The `visible: false` + `focus: true` window config could leave the panel
  showing on Windows, which both put a stray window on screen and permanently
  stalled the clipboard poller (it pauses while the panel is open).
- Clipboard poller: skip-state transitions are logged, and `PLUKS_POLL_DEBUG=1`
  enables a per-tick trace (heartbeat + stage-by-stage), so a silent capture
  stall is diagnosable from stderr alone.

## [v0.6.0] - 2026-06-12

### Fixed
- Desktop app: successful captures were never reported to analytics — only the
  suppression path (`selection_capture_failed`) was wired, so the app showed
  zero `selection_captured` events in PostHog for its entire history while
  capture itself worked fine. The `new-selection` listener now tracks the
  success event (kind, char-count bucket; never content).
- Analytics digest: the daily email now excludes datacenter/bot traffic
  (Chrome Web Store sandbox installs were ~98% of tracked "users"), matching
  the PostHog truth-layer filters. Direct HogQL queries bypass PostHog's
  test-account filters, so the exclusion is applied in the script itself.

### Changed
- Clipboard history now keeps your last 200 clips, up from 100, in both the
  desktop app and the browser extension.

### Added
- Clipboard now captures **every** copy, not just the select-to-copy gesture. A
  background clipboard watcher records anything that reaches the system
  clipboard — a manual Cmd+C / Ctrl+C, right-click → Copy, a "Copy" button, or a
  copy from another app — into history, so it shows in the panel and is what
  long-press pastes. Previously only drag-select / double-click / Cmd+A were
  recorded; a plain Ctrl+C landed on the OS clipboard but never in Pluks.
  - **Privacy:** content the source flags as concealed is never read or stored.
    On macOS that's the `org.nspasteboard.ConcealedType` / `TransientType`
    pasteboard markers; on Windows it's `ExcludeClipboardContentFromMonitorProcessing`
    and `CanIncludeInClipboardHistory=0`. This is the standard signal password
    managers set to stay out of clipboard history. (Linux concealed-type
    filtering is not implemented yet — tracked as a follow-up.)
  - The watcher only reads the clipboard (no synthesized input), so it works
    even before Accessibility / Input Monitoring are granted, and is the first
    capture path that functions under Wayland.
  - "Disable Auto-Copy" pauses the watcher too; Pluks's own writes (copying a
    history item, long-press paste) don't echo back as duplicate entries.
- Website: a feedback widget pinned to the bottom-right of every page. Visitors
  can write a query, bug report, or idea and send it — the form hands off to a
  pre-filled email to parth.dixit@alumni.iitd.ac.in (also shown as a direct
  mailto link for anyone who'd rather email straight away). Submissions emit
  anonymous, content-free analytics (length bucket + whether a reply email was
  given); the message text itself is never transmitted to PostHog.
- `LICENSE` file with the MIT text at the repo root. The site and README
  already said "MIT licensed", but without the file GitHub reported
  `license: None`; the license is now machine-detectable.
- Website: Open Graph / Twitter card meta tags on every page plus a branded
  1200×630 social card (`og-card.png`) with a "Download Now" CTA, so links
  shared on X/LinkedIn/Discord/Slack render a rich preview instead of a bare
  link.
- README: demo GIF, centered one-line pitch, and per-OS download badges at the
  top; `extension/` added to the repository layout table; license section now
  links to the LICENSE file.

## [v0.5.1] - 2026-06-11

_Never shipped standalone — first published as part of v0.6.0._

### Fixed
- macOS: nudges never appeared — not the copy/paste affirmations, the corrective
  hint, the long-press discovery nudge, nor the tray "Test Nudge" diagnostic.
  Pluks runs as a menu-bar accessory app (`LSUIElement` + `Accessory` activation
  policy), so it is almost never the *active* application when a nudge fires.
  AppKit's `orderFront:` — which the window show path relied on — is a no-op for
  an inactive app, so the transparent nudge overlay never came to the front and
  never composited. The nudge window now calls `orderFrontRegardless` after
  showing, without taking key focus, so the pill appears without stealing
  keystrokes from whatever app you're typing in.

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
