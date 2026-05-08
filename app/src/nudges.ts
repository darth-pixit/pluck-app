/**
 * Adaptive nudge engine. Decides whether to show affirmation
 * ("✦ Snagged") and corrective ("Already copied") nudges based on
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

// Affirmation decay: how often to fire as `selects_total` grows.
// Picked so a brand-new user gets steady reinforcement (every capture
// for the first 5), then steadily fewer until ~5/sec at hour-1 of
// usage feels like ambient sparkle, then nothing past 200 captures.
const AFFIRMATION_TIERS: Array<{ until: number; everyN: number }> = [
  { until: 5,   everyN: 1  },
  { until: 20,  everyN: 2  },
  { until: 50,  everyN: 5  },
  { until: 200, everyN: 20 },
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

export type NudgeKind = "affirmation" | "corrective";

export type NudgeDecision =
  | { show: true; kind: NudgeKind; text: string }
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
  };
}

/** Called on every successful Pluks capture (one per `new-selection` event). */
export function decideAffirmation(): NudgeDecision {
  const before = read(KEY_SELECTS);
  // Increment first — the decision uses the post-increment count so the
  // 5-tier "first 5" is genuinely the first 5 captures, not 0–4.
  const selects = before + 1;
  write(KEY_SELECTS, selects);

  const tier = AFFIRMATION_TIERS.find(t => selects <= t.until);
  if (!tier) {
    return { show: false, reason: "past_decay_horizon" };
  }
  // every-Nth gating uses (selects - 1) so the first capture in a tier
  // always fires (modulo == 0 for selects=1, 6, 21, etc).
  if (((selects - 1) % tier.everyN) !== 0) {
    return { show: false, reason: "decay_skip" };
  }
  write(KEY_AFFIRMATIONS, read(KEY_AFFIRMATIONS) + 1);
  return { show: true, kind: "affirmation", text: "✦ Snagged" };
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
  if (stats.selects < CORRECTIVE_MIN_SELECTS) {
    return { show: false, reason: "below_baseline" };
  }
  if (stats.redundancyRatio < CORRECTIVE_MIN_REDUNDANCY_RATIO) {
    return { show: false, reason: "already_adopted" };
  }
  if (stats.redundancyRatio > CORRECTIVE_MAX_REDUNDANCY_RATIO) {
    return { show: false, reason: "non_adopter" };
  }
  const sinceLast = Date.now() - stats.lastCorrectiveAt;
  if (stats.lastCorrectiveAt > 0 && sinceLast < CORRECTIVE_COOLDOWN_MS) {
    return { show: false, reason: "cooldown" };
  }
  write(KEY_LAST_CORRECTIVE, Date.now());
  return { show: true, kind: "corrective", text: "Already copied — no Cmd+C needed" };
}

/** Test-only helper: wipe all nudge counters back to a clean slate. */
export function resetNudgeStats(): void {
  for (const k of [KEY_SELECTS, KEY_REDUNDANT, KEY_AFFIRMATIONS, KEY_LAST_CORRECTIVE]) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
}
