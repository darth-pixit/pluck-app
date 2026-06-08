# Pluks — Release Regression Test Plan

A standard, manually-executable suite of test cases covering every user-facing
feature across the three Pluks surfaces (desktop app, browser extension,
website). Run the entire suite before every release. A test failure on any
case marked **MUST PASS** is a release blocker.

## Automation status

A large fraction of the cases below run automatically on every push and PR via
`.github/workflows/tests.yml`. The four automated suites:

| Suite | Runner | Coverage |
| ----- | ------ | -------- |
| `app/` vitest + RTL | `cd app && npm test` | A2 (capture logic via mocks), A3-A6 panel + history + smart-paste, A7 nudge engine, A8 prefs, A9 updater notice, A12 activation flag, A13 analytics whitelist/scrub |
| `app/src-tauri` cargo test | `cd app/src-tauri && cargo test --lib` | A12 SQLite history (insert, dedup, cap, delete, clear, persist), settings (load/save/corrupt recovery, UUID shape), A2.4c paste-watch (aborts on imminent Cmd+V, expires cleanly on quiet drag, ignores stale paste count, **covers 120/280/450 ms realistic motor-reaction timings**) |
| `extension/` Playwright | `cd extension && npx playwright test` | B2 content-script auto-copy + toast, B3 storage dedup + cap, B4 popup search + click + clear + opt-out |
| `website/` Playwright | `cd website && npx playwright test` | C1 render + privacy, C2 demo toast, C3 download modal validation + lead persistence + close paths |

What is **NOT** automated and stays manual:

- A1 OS permission grants (TCC requires real macOS user session)
- A2 actual auto-copy via real Cmd+C synthesis into other apps
- A3.1 / A4 real Cmd+Shift+V global shortcut + paste-into-previous-app
- A10 tray menu (no API to drive macOS NSStatusBar from automation)
- A11 traffic-light close/minimize / drag-by-titlebar
- A14 install / upgrade path
- All hardware budgets in section E

Cases marked with **🤖** below have automated coverage. The list of automated
test files is the source of truth — this annotation is a navigation aid.

---

## How to use this document

- Tests are grouped by surface, then by user-visible feature area.
- Each case lists: pre-conditions → steps → expected outcome.
- Severity tags:
  - **MUST PASS** — release blocker; revert if broken
  - **SHOULD PASS** — fix before next release; ship with known-issue note
  - **NICE TO PASS** — polish; track as a follow-up
- Platform tags `[macOS]` `[Windows]` `[Linux]` `[Chrome]` `[Firefox]` indicate
  where the case is exercised. An untagged case applies everywhere.
- For each release, copy this file into a release-specific run sheet
  (e.g. `tests/runs/v0.2.13.md`) and fill in pass/fail per case.

### Pre-flight (do once before starting)

1. Build the desktop app for each target platform from the release tag:
   `cd app && npm run build && npm run tauri build`.
2. Build the browser extension zip from `extension/`.
3. Deploy the website preview from `website/`.
4. Have a **fresh** OS user (or wipe `~/Library/Application Support/com.pluks.app/`,
   `%APPDATA%\com.pluks.app\`, `~/.local/share/com.pluks.app/`) so first-run
   flows can be exercised.
5. Have a **second** machine/account that already has Pluks installed for
   upgrade-path testing.

---

# A. Desktop App (Tauri + React)

## A1. First-run / install

### A1.1 Fresh install boots to onboarding tour [MUST PASS]
- **Pre:** No `settings.json`, no `localStorage`, no SQLite db.
- **Steps:** Launch app for the first time.
- **Expect:**
  - 3-step "Select to copy / Your last 100 clips / Privacy first" tour shows.
  - Progress dots reflect current step.
  - "Skip" and "Next →" buttons both work.
  - On final step, primary button reads "Get started".

### A1.2 Tour does not re-show on relaunch [MUST PASS]
- **Pre:** Completed or skipped A1.1.
- **Steps:** Fully quit (tray → Quit) and relaunch.
- **Expect:** Tour does **not** re-appear; `pluks.onboarding.v1.seen` exists in localStorage.

### A1.3 Permission setup screen appears after tour [MUST PASS] [macOS]
- **Pre:** A1.1 dismissed.
- **Expect:**
  - Two pending steps: Accessibility, Input Monitoring.
  - "Grant →" button on each opens the corresponding macOS pane.
  - Step icon flips to "✓" after each grant within ~2s (poll interval).

### A1.4 Setup screen on Windows/Linux [SHOULD PASS] [Windows] [Linux]
- **Pre:** Fresh install on Win/Linux.
- **Expect:**
  - App proceeds without macOS-specific permission prompts.
  - "Hide ✕" button is visible (macOS hides it).

### A1.5 Activation tour appears once after permissions land [MUST PASS]
- **Pre:** Onboarding tour seen + both permissions granted, no `pluks.activation.v1.seen`.
- **Expect:**
  - 4 gated steps: select-1 → paste → select-2 → ⌘⇧V.
  - "Next →" remains disabled until each gesture is detected.
  - After the final step, `pluks.activation.v1.seen` is set.

### A1.6 Skipping activation tour records steps_done [SHOULD PASS]
- **Steps:** Click "Skip" on step 2.
- **Expect:** PostHog `activation_completed` event has `dismiss_reason="skipped"`, `steps_done=1`.

### A1.7 First launch enables autostart exactly once [SHOULD PASS]
- **Pre:** Fresh install.
- **Expect:**
  - Auto-launch is registered (Login Items on macOS, Run key on Windows,
    `.desktop` autostart entry on Linux).
  - Subsequent launches do NOT silently re-enable a user's manual disable.

---

## A2. Auto-copy (selection capture)

### A2.1 Drag-select copies and stacks history [MUST PASS]
- **Pre:** Permissions granted, watcher enabled, panel hidden.
- **Steps:** Drag-select text in any AX-enabled app (Safari, TextEdit).
- **Expect:**
  - Selected text lands in system clipboard (Cmd+V pastes it).
  - Affirmation nudge "✦ Copied" shows briefly near cursor.
  - Open panel → first item == selected text.

### A2.2 Double-click word copies [MUST PASS]
- **Steps:** Double-click a word in any text.
- **Expect:** Word added to history; nudge shows.

### A2.3 Triple-click line copies [SHOULD PASS]
- **Steps:** Triple-click in TextEdit.
- **Expect:** Whole line lands in history.

### A2.4 Selection inside editable field IS captured [MUST PASS]
- **Pre:** Focus inside an editable text field (TextEdit document, Notes app,
  WhatsApp composer, Terminal.app text view). No Cmd+V follows within ~500 ms.
- **Steps:** Drag-select 2–3 words within that field, then pause (don't
  paste).
- **Expect:**
  - Text **is** captured to history (after the ~500 ms paste-watch window).
  - Clipboard **is** overwritten with the selection.
  - No `capture-suppressed` event emitted.

### A2.4c Select-to-replace lands prior clipboard [MUST PASS]
- **Pre:** Capture "alpha" from a non-editable area (Safari page text).
  Focus TextEdit and type "bravo".
- **Steps:** Drag-select "bravo" and press Cmd+V at any natural speed
  (the watch window spans up to ~500 ms — covers the 5th–95th percentile
  of motor-reaction time, ~120 ms to ~450 ms).
- **Expect:**
  - "alpha" replaces "bravo" in the document.
  - No `selection_captured` event for "bravo".
  - One `selection_capture_failed` event with `reason="paste_within_window"`.
  - History still has "alpha" as the top row (not "bravo").
- **History note:** v0.3.0 first wired the watch at 180 ms; v0.4.0
  inherited that, but real users press Cmd+V at 200–450 ms post-drag.
  v0.4.x widens the window to the Apple HIG 500 ms gesture-beat ceiling.

### A2.4d Slow replace falls back to no-op [SHOULD PASS]
- **Pre:** Same setup as A2.4c.
- **Steps:** Drag-select "bravo", wait ≥700 ms, then press Cmd+V.
- **Expect:**
  - "bravo" remains in the document (the just-captured clipboard pastes
    back over itself — visual no-op).
  - `selection_captured` fires for "bravo"; it's now the top history row.
  - This is the documented trade-off — users who out-wait the
    `PASTE_WATCH_MS` window lose the replace flow but never get
    wrong-paste; they can recover the prior value from the panel.

### A2.4b Selection inside password field is suppressed [MUST PASS]
- **Pre:** Focus inside an `AXSecureTextField` (Safari password input, the
  macOS unlock prompt, 1Password's create-password sheet).
- **Steps:** Drag-select within the password field.
- **Expect:**
  - Text is **not** captured to history.
  - Clipboard is **not** overwritten.
  - PostHog `selection_capture_failed` with `reason="secure_field"` fired.

### A2.5 Selection while panel visible is ignored [MUST PASS]
- **Pre:** Panel open.
- **Steps:** Switch to a webpage, drag-select.
- **Expect:** No new history item; no nudge.

### A2.6 Selection with watcher disabled is ignored [MUST PASS]
- **Pre:** Tray → "Disable Auto-Copy".
- **Steps:** Drag-select.
- **Expect:** Nothing captured. Tray label flips to "Enable Auto-Copy".

### A2.7 Re-enabling watcher resumes capture [MUST PASS]
- **Steps:** From A2.6, click "Enable Auto-Copy", select text again.
- **Expect:** Capture resumes. Tray label flips back.

### A2.8 Capture works over full-screen Spaces [MUST PASS] [macOS]
- **Steps:** Make Safari full-screen, select text.
- **Expect:** Item captured; nudge appears (panel may be invoked over fullscreen too).

### A2.9 Capture survives sleep / wake [SHOULD PASS]
- **Steps:** Sleep machine 1 min → wake → select text.
- **Expect:** Capture works without restart.

### A2.10 Identical re-selection does not duplicate [MUST PASS]
- **Steps:** Select the same text twice in a row.
- **Expect:** Top-of-history row is re-used (timestamp may update); panel shows 1 row, not 2.

### A2.11 Manual Cmd+C within 5s emits `manual-copy` [SHOULD PASS]
- **Pre:** Panel hidden, just captured an item.
- **Steps:** Select text → wait → press Cmd+C on the same selection.
- **Expect:** PostHog receives `manual_copy_pressed` with `since_last_capture_ms_bucket`.

### A2.12 Synthetic Cmd+C from Pluks itself is filtered [MUST PASS]
- **Pre:** Two selections made through normal capture.
- **Expect:** No `manual_copy_pressed` events generated by Pluks's own `simulate_copy()`
  within 250 ms of a capture.

---

## A3. History panel UI

### A3.1 Cmd+Shift+V toggles panel [MUST PASS]
- **Steps:** From any app, press Cmd+Shift+V (Ctrl+Shift+V on Win/Linux).
- **Expect:** Panel appears, search input is focused. Press again → panel hides.

### A3.2 Tray "Show / Hide History" toggles panel [MUST PASS]
- **Expect:** Identical behavior to A3.1.

### A3.3 Tray left-click toggles panel [MUST PASS]
- **Steps:** Left-click the menu-bar icon.
- **Expect:** Panel toggles.

### A3.4 Click outside panel hides it [MUST PASS]
- **Pre:** Panel open.
- **Steps:** Click on the desktop or another app.
- **Expect:** Panel hides within ~250 ms of blur.

### A3.5 Escape hides panel [MUST PASS]
- **Steps:** With panel open, press Esc.
- **Expect:** Panel hides; PostHog `panel_closed` with `dismiss_reason="escape"`.

### A3.6 Empty history shows hint [SHOULD PASS]
- **Pre:** History empty.
- **Expect:** Panel says "Select any text to start collecting".

### A3.7 Item count badge reflects history size [SHOULD PASS]
- **Expect:** Titlebar shows `N / 100`.

### A3.8 Items render newest-first [MUST PASS]
- **Steps:** Select text A → text B.
- **Expect:** B is at top, A second.

### A3.9 Long content is truncated in preview [SHOULD PASS]
- **Steps:** Select >120-char string.
- **Expect:** Preview ends with "…"; full text retained internally.

### A3.10 Time-ago labels render correctly [SHOULD PASS]
- **Expect:**
  - <60s → "just now"
  - <1h → "Xm ago"
  - <1d → "Xh ago"
  - else → "Xd ago"
- Labels refresh roughly once per minute without an external trigger.

### A3.11 Char count shows [NICE TO PASS]
- **Expect:** Each row shows "N chars".

### A3.12 SQLite stores UTC; UI displays local time correctly [SHOULD PASS]
- **Steps:** Set TZ to UTC-8, capture text, check "X minutes ago".
- **Expect:** Label is correct; not 8h off.

---

## A4. History interaction

### A4.1 Click row pastes into previous app [MUST PASS]
- **Pre:** Open TextEdit, type some text, capture more text, open panel.
- **Steps:** Click a row.
- **Expect:**
  - Panel hides.
  - TextEdit re-activates (target_pid restoration).
  - The clicked content is pasted at the cursor.

### A4.2 Enter pastes the active row [MUST PASS]
- **Steps:** Open panel, navigate to row 3 with arrow keys, press Enter.
- **Expect:** Row 3 pastes into the previous app.

### A4.3 ↑/↓ arrow keys navigate [MUST PASS]
- **Expect:** Active row highlight moves; scrolls into view at edges.

### A4.4 Cmd+Shift+↑/↓ navigates while panel is up [SHOULD PASS] [macOS]
- **Pre:** Panel open.
- **Expect:** Active row moves; macOS doesn't swallow the arrows.

### A4.5 Mouse hover changes active row [SHOULD PASS]
- **Expect:** Hovering a row highlights it; smart-paste actions update.

### A4.6 Backspace / Delete on active row deletes it [MUST PASS]
- **Steps:** Navigate to a row, press Backspace.
- **Expect:** Row removed from list and from SQLite.

### A4.7 Backspace inside the search input does NOT delete [MUST PASS]
- **Pre:** Some search text typed.
- **Steps:** Press Backspace in the search field.
- **Expect:** Character deleted; row not removed.

### A4.8 ✕ delete button removes a row [MUST PASS]
- **Steps:** Click the × on a row.
- **Expect:** Row removed; panel does NOT trigger paste.

### A4.9 "Clear all" empties history [MUST PASS]
- **Steps:** Click "Clear all" footer button.
- **Expect:** History wipes; SQLite count = 0; panel shows empty hint.

### A4.10 Fresh top-row auto-skip to row 2 [SHOULD PASS]
- **Pre:** Top item less than 5s old (just captured).
- **Steps:** Open panel.
- **Expect:** Active highlight starts on row 2 (anti-self-paste guard).

### A4.11 Older top row defaults to row 1 [SHOULD PASS]
- **Pre:** Top item >5s old.
- **Expect:** Active highlight on row 1.

---

## A5. Search

### A5.1 Live filtering [MUST PASS]
- **Steps:** Type in search field.
- **Expect:** Rows filter case-insensitively in real time.

### A5.2 No-match state [SHOULD PASS]
- **Steps:** Type a string that matches nothing.
- **Expect:** Panel shows "No matches".

### A5.3 Clearing search restores list [MUST PASS]
- **Expect:** Deleting query reveals full list.

### A5.4 Search debounce for analytics [NICE TO PASS]
- **Expect:** Only one `history_searched` event per ~500ms typing burst.

---

## A6. Smart-paste detectors

For each kind, capture the source text → open panel → confirm the
correct **badge** + the listed **action buttons** appear → click each action
→ confirm the pasted output matches.

### A6.1 URL detection [MUST PASS]
- **Input:** `https://example.com/path?x=1#a`
- **Badge:** `URL`
- **Actions:** `Plain` → input as-is; `Markdown` → `[example.com](...)`;
  `HTML <a>` → `<a href="...">example.com</a>`; `No params` → `https://example.com/path`.

### A6.2 www-prefix URL [SHOULD PASS]
- **Input:** `www.example.com`
- **Expect:** Detected as URL; normalized to `https://www.example.com`.

### A6.3 Email detection [MUST PASS]
- **Input:** `alice@example.com`
- **Badge:** `Email`
- **Actions:** `Plain`, `mailto:alice@example.com`, Markdown variant.

### A6.4 Hex color detection [MUST PASS]
- **Input:** `#FC4C02`
- **Badge:** `Color`
- **Actions:** Plain; #hex; `rgb(252, 76, 2)`; valid `hsl(...)`.

### A6.5 Hex 3-digit, 4-digit, 8-digit forms [SHOULD PASS]
- **Inputs:** `#abc`, `abcd`, `#aabbccdd`, all expand to 6-digit then convert.

### A6.6 JSON detection — object [MUST PASS]
- **Input:** `{"a":1,"b":[2,3]}`
- **Badge:** `JSON`
- **Actions:** Plain; Pretty (multi-line); Minify.

### A6.7 JSON detection — array [SHOULD PASS]
- **Input:** `[1,2,3]` → JSON badge.

### A6.8 JSON > 500 KB skipped [SHOULD PASS]
- **Input:** 600 KB JSON-ish string.
- **Expect:** No JSON badge; falls through to other detectors / no badge.

### A6.9 Code detection [SHOULD PASS]
- **Input:** A 5-line C-style snippet with semicolons or 4-sp indent.
- **Badge:** `Code`
- **Actions:** Plain; ```` ```fenced``` ````; "Indent 4sp".

### A6.10 Already-fenced code unwraps [SHOULD PASS]
- **Input:** ```` ```js\nconst x=1;\n``` ````
- **Expect:** Plain emits `const x=1;`.

### A6.11 Plain text shows no smart-paste row [MUST PASS]
- **Input:** `Hello world`.
- **Expect:** No paste-actions row; copy-on-click still works.

### A6.12 Smart-paste click pastes & hides panel [MUST PASS]
- **Steps:** Open panel → click "rgb()" on a color row.
- **Expect:** Panel hides; previous app receives the rgb form via Cmd+V.

---

## A7. Nudges (adaptive)

### A7.1 Affirmation fires for first 20 captures [MUST PASS]
- **Pre:** Reset nudge stats (or fresh install).
- **Steps:** Capture 20 distinct selections in <1 min.
- **Expect:** "✦ Copied" pill appears for each.

### A7.2 Affirmation decays per tier [SHOULD PASS]
- **Steps:** Continue capturing past 20 → 50 → 100 → 200.
- **Expect:** Nudge frequency drops to every-3 → every-10 → every-25 → none.

### A7.3 Nudge auto-dismisses ~1.1s [SHOULD PASS]
- **Expect:** Pill is visible briefly, fades; never persists.

### A7.4 Back-to-back nudges retarget cleanly [SHOULD PASS]
- **Steps:** Trigger 2 captures within 200 ms of each other.
- **Expect:** Second nudge replaces first without flicker; one isn't yanked early
  by the prior hide task.

### A7.5 Corrective fires only after `selects ≥ 20` [SHOULD PASS]
- **Pre:** Captures < 20.
- **Steps:** Trigger manual-copy event.
- **Expect:** No corrective nudge; `nudge_suppressed` reason `below_baseline`.

### A7.6 Corrective is throttled to once/min [SHOULD PASS]
- **Pre:** Conditions to fire corrective are met.
- **Steps:** Trigger two manual-copies within 60 s.
- **Expect:** Only the first fires.

### A7.7 Corrective skipped for >95% manual ratio [SHOULD PASS]
- **Expect:** `nudge_suppressed` reason `non_adopter`.

### A7.8 Corrective skipped for <5% manual ratio [SHOULD PASS]
- **Expect:** `nudge_suppressed` reason `already_adopted`.

### A7.9 Nudge window is click-through and non-activating [MUST PASS]
- **Steps:** Click on the pill location.
- **Expect:** Click passes through to the underlying app; Pluks is not activated.

---

## A8. Preferences screen

### A8.1 Open / close prefs [MUST PASS]
- **Steps:** Click ⚙ in titlebar; click ← to return.

### A8.2 Toggle "Send anonymous usage stats" [MUST PASS]
- **Steps:** Uncheck.
- **Expect:**
  - `analytics_opted_out` event fires before flag flips.
  - `settings.json` has `"opt_out": true`.
  - PostHog stops capturing further events.
  - Re-checking sends `analytics_opted_in` and resumes capture.

### A8.3 Toggle "Send crash reports" [MUST PASS]
- **Steps:** Uncheck.
- **Expect:** `crash_opt_out=true`; subsequent thrown errors do not reach Sentry.

### A8.4 Reset anonymous ID [MUST PASS]
- **Steps:** Click "Reset anonymous ID".
- **Expect:**
  - Button shows "Resetting…" while running.
  - New UUID rendered after.
  - PostHog distinct_id rotates (`posthog.reset()` then `identify`).

### A8.5 About section shows app version [SHOULD PASS]

---

## A9. Updater

### A9.1 No updater banner when none available [MUST PASS]
- **Pre:** Latest version installed.
- **Expect:** Within 5s + 6h, no banner; updater status stays `idle`.

### A9.2 Background download → "ready" banner [MUST PASS]
- **Pre:** A newer version is published in the update endpoint.
- **Expect:**
  - Within 5s of launch, status moves to `downloading` then `ready`.
  - Banner shows version and up to 4 release-note bullets.
  - Banner does **not** show during `downloading`.

### A9.3 Release-notes parsing [SHOULD PASS]
- **Input:** A body containing `* item 1`, `- item 2`, an inline `**bold**`, and a 200-char bullet.
- **Expect:** Up to 4 plain-text bullets, ≤140 chars each, no Markdown noise.

### A9.4 "Install & restart" applies update [MUST PASS]
- **Steps:** Click primary button.
- **Expect:** App relaunches into new version; SQLite history persists.

### A9.5 "Later" defers to next quit [MUST PASS]
- **Steps:** Click "Later" → use app a bit → tray "Quit Pluks".
- **Expect:**
  - Banner stays dismissed in current session.
  - On quit, `app-quit-requested` listener installs the staged update.
  - Next launch is the new version.

### A9.6 Banner does not re-show for the same version [SHOULD PASS]
- **Pre:** Same staged version dismissed in A9.5.
- **Expect:** No banner on subsequent launches for that version.

### A9.7 Network failure during background check is silent [MUST PASS]
- **Pre:** Block the update endpoint.
- **Expect:** No user-visible error; status returns to `idle`; `update_check_failed` event fired.

---

## A10. Tray menu

### A10.1 Tray "Disable / Enable Auto-Copy" toggles label [MUST PASS]
- **Expect:** Label flips between the two strings; capturing pauses/resumes.

### A10.2 Tray "Quit Pluks" exits cleanly [MUST PASS]
- **Expect:**
  - Frontend gets ~800 ms to stage an install.
  - Process exits 0; tray icon removed.

### A10.3 Tray icon visible after relaunch [SHOULD PASS]

---

## A11. Window behavior

### A11.1 Traffic-light Close hides (does not quit) [MUST PASS] [macOS]
- **Steps:** Click red dot in titlebar.
- **Expect:** Panel hides; app stays running; tray remains.

### A11.2 Traffic-light Minimize falls back to hide [SHOULD PASS] [macOS]

### A11.3 Drag-by-titlebar moves panel [SHOULD PASS]
- **Expect:** Panel can be dragged; not dragged when starting on a button/input.

### A11.4 Always-on-top during normal use [MUST PASS]
- **Expect:** Panel floats over other apps including full-screen apps (macOS).

### A11.5 Always-on-top is dropped during permission setup [SHOULD PASS] [macOS]
- **Pre:** Setup screen visible, click "Grant →".
- **Expect:** Panel does NOT obscure System Settings.

---

## A12. Persistence & quotas

### A12.1 History persists across restarts [MUST PASS]
- **Steps:** Capture 3 items → quit → relaunch.
- **Expect:** All 3 still visible.

### A12.2 100-item cap is enforced [MUST PASS]
- **Steps:** Capture 110 distinct items.
- **Expect:** Only newest 100 retained; oldest 10 dropped.

### A12.3 Settings persist across restart [MUST PASS]
- **Steps:** Toggle opt-out → relaunch.
- **Expect:** Opt-out remains; same `anon_id`.

### A12.4 Corrupt `settings.json` is rebuilt safely [SHOULD PASS]
- **Steps:** Replace settings file with `not json` → launch.
- **Expect:** App launches; fresh settings written.

### A12.5 SQLite WAL mode used [NICE TO PASS]
- **Expect:** `pluck.db-wal` exists during use.

---

## A13. Privacy / analytics safety

### A13.1 No clipboard content in any analytics payload [MUST PASS]
- **Steps:** With network sniffer / PostHog inspector, capture text containing
  the string `SECRET_TEST_TOKEN_42` and let nudges/tracking fire.
- **Expect:** Token never appears in any outbound request.

### A13.2 Schema allow-list drops unknown event keys [MUST PASS]
- **Steps:** Manually call `track("history_loaded", { content: "leak" })`.
- **Expect:** `content` is not transmitted; only allow-listed keys (`item_count`, `load_ms`).

### A13.3 Sentry payloads scrub `/Users/<name>` and `/home/<name>` [MUST PASS]
- **Steps:** Throw an Error containing `/Users/alice/code/foo`.
- **Expect:** Sentry receives `/Users/~/code/foo`.

### A13.4 Opt-out blocks all PostHog captures [MUST PASS]
- **Steps:** Opt out → exercise app.
- **Expect:** Zero outbound requests to `us.i.posthog.com`.

### A13.5 Crash opt-out blocks Sentry [MUST PASS]
- **Steps:** Crash opt-out → throw uncaught error.
- **Expect:** Zero outbound requests to `*.ingest.sentry.io`.

### A13.6 Dev placeholder keys disable analytics [MUST PASS]
- **Pre:** `VITE_POSTHOG_KEY` contains `PLACEHOLDER`.
- **Expect:** `[pluks-app] PostHog disabled` console warning; no PostHog events.

---

## A14. Install / upgrade path

### A14.1 macOS Universal `.dmg` install [MUST PASS] [macOS]
- **Steps:** Drag to Applications → first launch → open from Spotlight.
- **Expect:** App opens; Gatekeeper accepts the signed/notarized bundle.
- **Apple Silicon:** Single `_universal.dmg` asset on the release; first launch
  shows **no Rosetta prompt**. Confirm native arch in Activity Monitor (Kind =
  "Apple", not "Intel").

### A14.2 Windows `.msi` install [MUST PASS] [Windows]
- **Expect:** Installer completes; Start menu entry exists; SmartScreen allows.

### A14.3 Linux `.AppImage` runs [MUST PASS] [Linux]
- **Expect:** `chmod +x` + run launches; tray appears (with compositor support).

### A14.4 Linux `.deb` install [SHOULD PASS] [Linux]

### A14.5 Upgrade preserves history & settings [MUST PASS]
- **Steps:** N-1 install with 50 captures + opt-out → upgrade in place.
- **Expect:** All 50 captures + opt-out preserved post-upgrade.

### A14.6 `app_updated` event fires once per version bump [SHOULD PASS]
- **Expect:** PostHog `app_updated` with `from_version`, `to_version`. Not on
  same-version relaunches.

---

# B. Browser Extension (MV3)

## B1. Install

### B1.1 Fresh install records `app_installed` [MUST PASS]
- **Pre:** No prior install.
- **Steps:** Load unpacked / install from store.
- **Expect:** `app_installed` event with `install_source` = `chrome` or `firefox`.

### B1.2 Update bumps `app_updated` [SHOULD PASS]
- **Steps:** Replace extension with newer version.
- **Expect:** `app_updated` with `from_version` / `to_version`.

### B1.3 Service worker `app_launched` on cold start [SHOULD PASS]
- **Steps:** Disable + re-enable extension.
- **Expect:** `app_launched` with `cold_start: true`.

## B2. Content-script auto-copy

### B2.1 Drag-select on https page copies + toasts [MUST PASS] [Chrome] [Firefox]
- **Steps:** Drag-select text on `https://example.com`.
- **Expect:**
  - Toast "Snagged! …" bottom-right with preview.
  - System clipboard contains the selection.
  - History gets the entry (popup will show it).

### B2.2 Double-click word copies [MUST PASS]
- **Expect:** Word in clipboard + toast.

### B2.3 Single-click without drag does NOT copy [MUST PASS]
- **Steps:** Click once with no movement (<4 px).
- **Expect:** No toast; no history entry.

### B2.4 No injection on `chrome://`, `about:`, `view-source:` [SHOULD PASS]
- **Expect:** Content script absent (manifest matches only `http(s)://*/*`).

### B2.5 No double-injection in iframes [SHOULD PASS]
- **Expect:** `window.__pluks_injected` guard prevents duplicate listeners.

### B2.6 Cross-origin iframe clipboard failure tracked [SHOULD PASS]
- **Steps:** Trigger select inside an `<iframe>` from another origin.
- **Expect:** `selection_capture_failed` with reason `cross_origin` or `permission`.

### B2.7 Toast disappears after ~2s [NICE TO PASS]

### B2.8 `content_kind` classification matches detectors [SHOULD PASS]
- **Steps:** Select an email, URL, hex, JSON, code in turn.
- **Expect:** `selection_captured.content_kind` = `email`, `url`, `color`, `json`, `code`.

### B2.9 Selection text never appears in any analytics payload [MUST PASS]
- **Steps:** Select `SECRET_TEST_TOKEN_42` on a public page.
- **Expect:** Token absent from every outbound request to PostHog/Sentry.

## B3. Background storage

### B3.1 History stored in `chrome.storage.local` [MUST PASS]
- **Steps:** Inspect `chrome.storage.local.history`.
- **Expect:** Array of `{text, ts}` objects, newest first.

### B3.2 Deduplicates exact-match text [MUST PASS]
- **Steps:** Select the same exact text twice.
- **Expect:** Only one entry; `ts` updated.

### B3.3 100-item cap [MUST PASS]
- **Steps:** Capture 110 distinct selections.
- **Expect:** `history.length === 100`; oldest dropped.

## B4. Popup UI

### B4.1 Popup opens on action click [MUST PASS]
- **Expect:** Search input visible; history list rendered.

### B4.2 Empty state [SHOULD PASS]
- **Pre:** Empty history.
- **Expect:** "No history yet…" placeholder.

### B4.3 Click row writes to clipboard [MUST PASS]
- **Steps:** Click a row.
- **Expect:**
  - Right-side hint flashes "✓" for ~800 ms.
  - Clipboard contains the row's text.
  - Pasting in another tab inserts it.

### B4.4 Search filter [MUST PASS]
- **Steps:** Type into search.
- **Expect:** Live case-insensitive filter; debounced `popup_searched` event after 500 ms idle.

### B4.5 Escape closes popup [SHOULD PASS]

### B4.6 Time-ago labels [SHOULD PASS]
- **Expect:** Same buckets as A3.10.

### B4.7 Clear All wipes [MUST PASS]
- **Steps:** Click "Clear all".
- **Expect:** Empty state shown; storage emptied.

### B4.8 Opt-out toggle persists [MUST PASS]
- **Steps:** Check opt-out → close popup → reopen.
- **Expect:** Still checked.

### B4.9 Opt-out blocks subsequent telemetry [MUST PASS]
- **Steps:** Opt out → trigger captures → check network.
- **Expect:** Zero PostHog traffic.

## B5. Privacy

### B5.1 No host permissions beyond `posthog`, `sentry` [MUST PASS]
- **Expect:** `manifest.json` only lists those two host permissions.

### B5.2 CSP forbids inline scripts [MUST PASS]

### B5.3 Permissions limited to `storage`, `clipboardWrite` [MUST PASS]

---

# C. Marketing website (`pluks.app`)

## C1. Render

### C1.1 Hero, stats, how-it-works, download sections render [MUST PASS]
- **Steps:** Load `index.html` in Chrome, Firefox, Safari.
- **Expect:** Layout intact at 1440×900, 1024×768, 375×812.

### C1.2 Custom font (Inter / JetBrains Mono) loads [SHOULD PASS]

### C1.3 No console errors [MUST PASS]

## C2. Interactive demo

### C2.1 Selecting demo text shows "Snagged!" toast [MUST PASS]
- **Steps:** Drag-select text in `#demo-text`.
- **Expect:**
  - Toast appears top-right with truncated preview.
  - Auto-fades after ~2.4 s.
  - Selection is written to clipboard.

### C2.2 Selecting other page text also fires demo handler [SHOULD PASS]
- **Note:** demo.js binds to `mouseup` on `document` — confirm not too aggressive.

### C2.3 Keyboard-driven selection (Shift+Arrow) triggers demo [SHOULD PASS]

### C2.4 Demo never sends selected text to analytics [MUST PASS]
- **Expect:** `demo_interacted` event has bucketed length only.

### C2.5 Three selections trigger `demo_completed` [NICE TO PASS]

## C3. Download flow

### C3.1 Platform auto-detect highlights correct card [SHOULD PASS]
- **Steps:** Visit on macOS / Windows / Linux UA.
- **Expect:** The matching card has orange border + custom CTA text.

### C3.2 Click "Download for macOS" opens modal [MUST PASS]
- **Expect:** Modal shows email + persona inputs; first input focused.

### C3.3 Submit with invalid email shows error [MUST PASS]
- **Steps:** Submit with `not-an-email`.
- **Expect:** Inline error "Please enter a valid work email."; no download.

### C3.4 Submit without persona shows error [MUST PASS]
- **Expect:** "Please pick a persona."

### C3.5 Valid submit downloads + posts lead [MUST PASS]
- **Steps:** Submit valid email + persona.
- **Expect:**
  - `download_form_submitted` PostHog event with `persona` and `platform`.
  - `sendBeacon` → Apps Script endpoint with email + persona + UA + referrer host.
  - Browser navigates to the platform-specific download URL.
  - `sessionStorage.pluks_dl_ok = "1"` set.

### C3.6 Email never sent to PostHog [MUST PASS]
- **Expect:** PostHog payload contains no `email` key.

### C3.7 Subsequent download click in same session bypasses modal [SHOULD PASS]
- **Steps:** Submit once → click another download link.
- **Expect:** Direct download, no modal.

### C3.8 Modal close paths [SHOULD PASS]
- **Expect:** Backdrop click, × button, Escape all close + emit `download_modal_closed` with the right `via` value.

### C3.9 LocalStorage fallback always saves the lead [MUST PASS]
- **Steps:** Submit form (with endpoint reachable or not).
- **Expect:** `localStorage.pluks_leads` array contains the entry.

## C4. Privacy page

### C4.1 `/privacy.html` renders [MUST PASS]

### C4.2 CNAME `pluks.app` resolves [MUST PASS]

## C5. Analytics

### C5.1 PostHog opt-out via website respected [SHOULD PASS]

### C5.2 Sentry browser SDK initialized only in production [SHOULD PASS]

---

# D. Cross-surface

## D1. Brand consistency

### D1.1 Logo / brand "pluks" lowercase across all surfaces [NICE TO PASS]

### D1.2 Shortcut hint string matches platform [SHOULD PASS]
- **Expect:** `⌘⇧V` on macOS, `Ctrl+Shift+V` on Windows/Linux, in app + extension + website copy.

## D2. Telemetry consistency

### D2.1 Both surfaces send `selection_captured` with `content_kind` [SHOULD PASS]
- **Expect:** Same allow-listed kinds (`url`, `email`, `color`, `json`, `code`, `text`).

### D2.2 Both surfaces respect opt-out independently [MUST PASS]

### D2.3 PostHog distinct IDs are stable per surface [SHOULD PASS]
- **Expect:**
  - App: `settings.json.anon_id` (UUIDv4).
  - Extension: `chrome.storage.local.pluks_anon_id`.
  - Website: PostHog's own anonymous cookie.
  - These are independent — same user appears as 3 distinct IDs.

## D3. End-to-end story

### D3.1 New user funnel [MUST PASS]
1. Land on website → demo selects work → hit Download → submit form.
2. Install → onboarding tour → permission setup → activation tour.
3. Capture 3 selections from different apps.
4. Open panel via Cmd+Shift+V → click row → it pastes.
5. Run smart-paste on a JSON row.
6. Toggle analytics off in prefs.
7. Install simulated update → "Install & restart" → app comes back with history intact.

All steps should complete with no error dialogs and no console exceptions.

---

# E. Performance & resource budgets

| Budget | Threshold | How to measure |
| ------ | --------- | -------------- |
| Cold start to ready panel | < 1.0 s | log first paint + `history_loaded` ms |
| Selection → nudge visible | < 350 ms | manual stopwatch / `capture_latency_ms` |
| Panel open after Cmd+Shift+V | < 200 ms | `panel_open_latency_ms` |
| Idle CPU (no input) | < 0.5 % | macOS Activity Monitor |
| Idle RAM | < 150 MB | macOS Activity Monitor |
| Background updater check time | < 5 s | log timing in dev |

Treat regressions of >25 % vs. last release as **MUST PASS** failures.

---

# F. Localization & accessibility

### F1.1 RTL locale (Hebrew/Arabic) doesn't break layout [SHOULD PASS]

### F1.2 200 % font scaling readable [SHOULD PASS]

### F1.3 Tour, banner, and prefs have correct ARIA [SHOULD PASS]
- **Expect:** `role="dialog"`, `aria-modal="true"`, `aria-live="polite"` on update banner, `aria-hidden="true"` on nudge root.

### F1.4 Keyboard-only navigation possible through tours [SHOULD PASS]

---

# G. Sign-off checklist

Before tagging a release:

- [ ] All **MUST PASS** cases on macOS pass
- [ ] All **MUST PASS** cases on Windows pass
- [ ] All **MUST PASS** cases on Linux pass
- [ ] All **MUST PASS** cases on Chrome pass
- [ ] All **MUST PASS** cases on Firefox pass
- [ ] All **MUST PASS** cases on the website pass
- [ ] Performance budgets within tolerance
- [ ] No regressions vs. previous release
- [ ] Sign-off recorded in `tests/runs/v<version>.md`
