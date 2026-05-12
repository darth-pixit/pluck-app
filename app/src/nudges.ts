/**
 * Adaptive nudge engine. Decides whether to show affirmation
 * ("✦ Copied") and corrective ("Already copied") nudges based on
 * the user's running adoption metrics.
 *
 * State lives in localStorage so it survives app relaunches but is
 * deliberately scoped per OS user — a reinstall resets the model,
 * which is what we want for QA.
 *
 * v1 thresholds — tune from the `nudge_shown` / `nudge_suppressed`
 * funnel in PostHog. Kept as named constants up top so changes don't
 * require digging through logic.
 */

const KEY_SELECTS = "pluks.nudges.selects_total";
const KEY_REDUNDANT = "pluks.nudges.redundant_copies_total";
const KEY_AFFIRMATIONS = "pluks.nudges.affirmations_shown_total";
const KEY_LAST_CORRECTIVE = "pluks.nudges.last_corrective_at";

// Paste-side (long-press radial) counters. Mirror the copy-side shape so
// the funnel works the same way in PostHog.
const KEY_HOLDS = "pluks.nudges.holds_total";
const KEY_HOLD_AFFIRMATIONS = "pluks.nudges.hold_affirmations_shown_total";
const KEY_HOLD_DISCOVERY_SHOWN = "pluks.nudges.hold_discovery_shown_total";
const KEY_LAST_HOLD_DISCOVERY = "pluks.nudges.last_hold_discovery_at";

// Affirmation decay: how often to fire as `selects_total` grows.
// Every capture for the first 20 so the muscle memory has time to
// form, then a gradual taper to ambient sparkle, then nothing past
// 200 captures.
const AFFIRMATION_TIERS: Array<{ until: number; everyN: number }> = [
  { until: 20,  everyN: 1  },
  { until: 50,  everyN: 3  },
  { until: 100, everyN: 10 },
  { until: 200, everyN: 25 },
];

// Same decay shape for the paste-side affirmation — symmetry with the
// copy-side nudge keeps both halves of the gesture pair learnable in
// the same number of repetitions.
const HOLD_AFFIRMATION_TIERS: Array<{ until: number; everyN: number }> = [
  { until: 20,  everyN: 1  },
  { until: 50,  everyN: 3  },
  { until: 100, everyN: 10 },
  { until: 200, everyN: 25 },
];

// Corrective fires only once `selects_total` clears this — before that
// we don't have enough signal to know if the user has adopted at all.
const CORRECTIVE_MIN_SELECTS = 20;
// Don't nudge people who never use the magic (>95% manual). Telling
// someone who reflexively hits Cmd+C "stop hitting Cmd+C" 50 times a
// day is the opposite of helpful.
const CORRECTIVE_MAX_REDUNDANCY_RATIO = 0.95;
// Don't nudge people who've already fully adopted (<5% manual).
const CORRECTIVE_MIN_REDUNDANCY_RATIO = 0.05;
// Throttle corrective so we never fire more than once per minute.
const CORRECTIVE_COOLDOWN_MS = 60_000;

// Hold discovery — fire at most once after the user has copied enough to
// have something worth pasting (10 captures), but only if they haven't
// discovered the long-press gesture on their own yet.
const HOLD_DISCOVERY_MIN_SELECTS = 10;
const HOLD_DISCOVERY_MAX_SHOWS = 1;
// Defensive cooldown — even if the cap above lifts (manual reset for QA),
// don't pester more than once an hour.
const HOLD_DISCOVERY_COOLDOWN_MS = 60 * 60_000;

export type NudgeKind = "affirmation" | "corrective" | "pasted_via_hold" | "hold_discovery";

export type NudgeDecision =
  | { show: true; kind: NudgeKind; text: string; selects: number }
  | { show: false; reason: string };

function read(key: string): number {
  try {
    const v = localStorage.getItem(key);
    return v ? parseInt(v, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

function write(key: string, value: number): void {
  try { localStorage.setItem(key, String(value)); } catch { /* private mode / quota */ }
}

export interface NudgeStats {
  selects: number;
  redundantCopies: number;
  affirmationsShown: number;
  lastCorrectiveAt: number;
  redundancyRatio: number;
  holds: number;
  holdAffirmationsShown: number;
  holdDiscoveryShown: number;
  lastHoldDiscoveryAt: number;
}

export function readStats(): NudgeStats {
  const selects = read(KEY_SELECTS);
  const redundant = read(KEY_REDUNDANT);
  return {
    selects,
    redundantCopies: redundant,
    affirmationsShown: read(KEY_AFFIRMATIONS),
    lastCorrectiveAt: read(KEY_LAST_CORRECTIVE),
    redundancyRatio: selects > 0 ? redundant / selects : 0,
    holds: read(KEY_HOLDS),
    holdAffirmationsShown: read(KEY_HOLD_AFFIRMATIONS),
    holdDiscoveryShown: read(KEY_HOLD_DISCOVERY_SHOWN),
    lastHoldDiscoveryAt: read(KEY_LAST_HOLD_DISCOVERY),
  };
}

/** Called on every successful Pluks capture (one per `new-selection` event). */
export function decideAffirmation(): NudgeDecision {
  // Increment first — the decision uses the post-increment count so
  // "first 20" is genuinely captures 1–20, not 0–19.
  const selects = read(KEY_SELECTS) + 1;
  write(KEY_SELECTS, selects);

  const tier = AFFIRMATION_TIERS.find(t => selects <= t.until);
  if (!tier) return { show: false, reason: "past_decay_horizon" };
  // every-Nth gating uses (selects - 1) so the first capture in a tier
  // always fires (modulo == 0 for selects=1, 21, 51, 101).
  if (((selects - 1) % tier.everyN) !== 0) return { show: false, reason: "decay_skip" };

  write(KEY_AFFIRMATIONS, read(KEY_AFFIRMATIONS) + 1);
  return { show: true, kind: "affirmation", text: "✦ Copied", selects };
}

/**
 * Called on every `manual-copy` event (user pressed Cmd+C/Ctrl+C
 * within 5s of a capture, with synthetic-Cmd+Cs already filtered Rust-
 * side). The bucket from the event isn't used here — we only care
 * about the count for the running ratio.
 */
export function decideCorrective(): NudgeDecision {
  write(KEY_REDUNDANT, read(KEY_REDUNDANT) + 1);

  const stats = readStats();
  if (stats.selects < CORRECTIVE_MIN_SELECTS) return { show: false, reason: "below_baseline" };
  if (stats.redundancyRatio < CORRECTIVE_MIN_REDUNDANCY_RATIO) return { show: false, reason: "already_adopted" };
  if (stats.redundancyRatio > CORRECTIVE_MAX_REDUNDANCY_RATIO) return { show: false, reason: "non_adopter" };
  const sinceLast = Date.now() - stats.lastCorrectiveAt;
  if (stats.lastCorrectiveAt > 0 && sinceLast < CORRECTIVE_COOLDOWN_MS) return { show: false, reason: "cooldown" };

  write(KEY_LAST_CORRECTIVE, Date.now());
  return { show: true, kind: "corrective", text: "✦ Already copied — just paste", selects: stats.selects };
}

/**
 * Called on every successful long-press radial paste. Mirrors
 * `decideAffirmation` but lives on its own counter so the two tiers
 * decay independently — a user who's mastered copy can still get the
 * first 20 affirmations on paste while they learn the hold gesture.
 */
export function decideHoldAffirmation(): NudgeDecision {
  const holds = read(KEY_HOLDS) + 1;
  write(KEY_HOLDS, holds);

  const tier = HOLD_AFFIRMATION_TIERS.find(t => holds <= t.until);
  if (!tier) return { show: false, reason: "past_decay_horizon" };
  if (((holds - 1) % tier.everyN) !== 0) return { show: false, reason: "decay_skip" };

  write(KEY_HOLD_AFFIRMATIONS, read(KEY_HOLD_AFFIRMATIONS) + 1);
  return { show: true, kind: "pasted_via_hold", text: "✦ Pasted", selects: holds };
}

/**
 * Called on every successful Pluks capture, *after* `decideAffirmation`.
 * Decides whether to surface a one-time discovery nudge teaching the
 * long-press paste gesture — the inverse of corrective. Fires when the
 * user clearly has enough banked clips to want them, but hasn't
 * organically found the hold gesture yet.
 */
export function decideHoldDiscovery(): NudgeDecision {
  const stats = readStats();
  if (stats.holds > 0) return { show: false, reason: "already_discovered" };
  if (stats.selects < HOLD_DISCOVERY_MIN_SELECTS) return { show: false, reason: "below_baseline" };
  if (stats.holdDiscoveryShown >= HOLD_DISCOVERY_MAX_SHOWS) return { show: false, reason: "shown_limit" };
  const sinceLast = Date.now() - stats.lastHoldDiscoveryAt;
  if (stats.lastHoldDiscoveryAt > 0 && sinceLast < HOLD_DISCOVERY_COOLDOWN_MS) {
    return { show: false, reason: "cooldown" };
  }

  write(KEY_HOLD_DISCOVERY_SHOWN, stats.holdDiscoveryShown + 1);
  write(KEY_LAST_HOLD_DISCOVERY, Date.now());
  return {
    show: true,
    kind: "hold_discovery",
    text: "✦ Press and hold to paste",
    selects: stats.selects,
  };
}

/** Test-only helper: wipe all nudge counters back to a clean slate. */
export function resetNudgeStats(): void {
  for (const k of [
    KEY_SELECTS,
    KEY_REDUNDANT,
    KEY_AFFIRMATIONS,
    KEY_LAST_CORRECTIVE,
    KEY_HOLDS,
    KEY_HOLD_AFFIRMATIONS,
    KEY_HOLD_DISCOVERY_SHOWN,
    KEY_LAST_HOLD_DISCOVERY,
  ]) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
}
