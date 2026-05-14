import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideAffirmation,
  decideCorrective,
  decideHoldAffirmation,
  decideHoldDiscovery,
  readStats,
  resetNudgeStats,
} from "./nudges";

beforeEach(() => {
  resetNudgeStats();
});

describe("decideAffirmation()", () => {
  it("fires for first 20 captures (every-1 tier)", () => {
    for (let i = 1; i <= 20; i++) {
      const d = decideAffirmation();
      expect(d.show).toBe(true);
      if (d.show) {
        expect(d.kind).toBe("affirmation");
        expect(d.text).toBe("✦ Copied");
        expect(d.selects).toBe(i);
      }
    }
  });

  it("decays to every-3 between 21 and 50", () => {
    for (let i = 0; i < 20; i++) decideAffirmation();
    let shown = 0;
    for (let i = 21; i <= 50; i++) {
      if (decideAffirmation().show) shown++;
    }
    // (selects-1) % 3 === 0 fires for selects in {22, 25, 28, 31, 34, 37, 40, 43, 46, 49} = 10
    expect(shown).toBe(10);
  });

  it("decays to every-10 between 51 and 100", () => {
    for (let i = 0; i < 50; i++) decideAffirmation();
    let shown = 0;
    for (let i = 51; i <= 100; i++) {
      if (decideAffirmation().show) shown++;
    }
    // (selects-1) % 10 === 0 fires for selects in {51, 61, 71, 81, 91} = 5
    expect(shown).toBe(5);
  });

  it("decays to every-25 between 101 and 200", () => {
    for (let i = 0; i < 100; i++) decideAffirmation();
    let shown = 0;
    for (let i = 101; i <= 200; i++) {
      if (decideAffirmation().show) shown++;
    }
    // (selects-1) % 25 === 0 fires for selects in {101, 126, 151, 176} = 4
    expect(shown).toBe(4);
  });

  it("stops firing after 200", () => {
    for (let i = 0; i < 200; i++) decideAffirmation();
    const d = decideAffirmation();
    expect(d.show).toBe(false);
    if (!d.show) expect(d.reason).toBe("past_decay_horizon");
  });

  it("increments selects counter regardless of show outcome", () => {
    for (let i = 0; i < 22; i++) decideAffirmation();
    expect(readStats().selects).toBe(22);
  });

  it("only increments affirmations counter on show", () => {
    for (let i = 0; i < 20; i++) decideAffirmation();
    expect(readStats().affirmationsShown).toBe(20);
    decideAffirmation(); // selects=21, every-3 tier, (21-1)%3===2 -> skip
    expect(readStats().affirmationsShown).toBe(20);
    decideAffirmation(); // selects=22, (22-1)%3===0 -> show
    expect(readStats().affirmationsShown).toBe(21);
  });

  it("returns reason 'decay_skip' when in tier but skipped", () => {
    for (let i = 0; i < 20; i++) decideAffirmation();
    const d = decideAffirmation(); // selects=21 in every-3; (21-1)%3 != 0
    expect(d.show).toBe(false);
    if (!d.show) expect(d.reason).toBe("decay_skip");
  });

  // ── forceShow=true (driven by the `show_nudges` preference) ─────────────
  //
  // The runtime call site passes forceShow=true so the affirmation pill
  // fires on *every* selection, bypassing AFFIRMATION_TIERS decay. We
  // keep counters incrementing so corrective/hold-discovery gates that
  // read `selects_total` continue to work.

  it("forceShow=true fires on a single selection well past the decay horizon", () => {
    for (let i = 0; i < 200; i++) decideAffirmation();
    // Without forceShow this would return show:false / past_decay_horizon.
    const d = decideAffirmation(true);
    expect(d.show).toBe(true);
    if (d.show) {
      expect(d.kind).toBe("affirmation");
      expect(d.selects).toBe(201);
    }
  });

  it("forceShow=true fires every selection across a full decay cycle", () => {
    let shown = 0;
    for (let i = 0; i < 250; i++) {
      if (decideAffirmation(true).show) shown++;
    }
    expect(shown).toBe(250);
  });

  it("forceShow=true still increments selects and affirmations counters", () => {
    for (let i = 0; i < 30; i++) decideAffirmation(true);
    const s = readStats();
    expect(s.selects).toBe(30);
    // All 30 fired → affirmations counter advances in lockstep.
    expect(s.affirmationsShown).toBe(30);
  });
});

describe("decideCorrective()", () => {
  it("suppresses when below 20 selects", () => {
    for (let i = 0; i < 19; i++) decideAffirmation();
    const d = decideCorrective();
    expect(d.show).toBe(false);
    if (!d.show) expect(d.reason).toBe("below_baseline");
  });

  it("fires the first time the redundancy ratio crosses 5% past 20 selects", () => {
    // 100 selects in storage with 0 redundant copies. The first
    // decideCorrective() call increments redundant→1 (1% ratio, suppressed).
    // We need ≥5% to fire on the very first non-suppressed call. So pre-load
    // 4 redundant copies via decideCorrective to push ratio to 5/100 = 0.05.
    for (let i = 0; i < 100; i++) decideAffirmation();
    // Pre-fill 4 redundant via direct localStorage write so we don't trip
    // the function's own throttle/cooldown writes.
    localStorage.setItem("pluks.nudges.redundant_copies_total", "4");
    const d = decideCorrective(); // increments to 5 → ratio 0.05, fires
    expect(d.show).toBe(true);
    if (d.show) {
      expect(d.kind).toBe("corrective");
      expect(d.text).toBe("✦ Already copied — just paste");
    }
  });

  it("suppresses when redundancy >95%", () => {
    for (let i = 0; i < 20; i++) decideAffirmation();
    // 20 selects, set redundant to 96 directly so ratio = 4.8 (>0.95)
    localStorage.setItem("pluks.nudges.redundant_copies_total", "96");
    const d = decideCorrective(); // bumps to 97/20 = 4.85
    expect(d.show).toBe(false);
    if (!d.show) expect(d.reason).toBe("non_adopter");
  });

  it("suppresses when redundancy <5%", () => {
    for (let i = 0; i < 100; i++) decideAffirmation();
    // 100 selects, 1 redundant call → 1% (<5%)
    const d = decideCorrective();
    expect(d.show).toBe(false);
    if (!d.show) expect(d.reason).toBe("already_adopted");
  });

  it("throttles to once per 60s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2030, 0, 1));
    for (let i = 0; i < 100; i++) decideAffirmation();
    localStorage.setItem("pluks.nudges.redundant_copies_total", "4");
    const first = decideCorrective(); // ratio crosses 5% → fires
    expect(first.show).toBe(true);
    const second = decideCorrective(); // same wall clock, cooldown blocks
    expect(second.show).toBe(false);
    if (!second.show) expect(second.reason).toBe("cooldown");
    // Fast-forward 61s — cooldown clears
    vi.setSystemTime(new Date(2030, 0, 1, 0, 1, 1));
    const third = decideCorrective();
    expect(third.show).toBe(true);
    vi.useRealTimers();
  });
});

describe("decideHoldAffirmation()", () => {
  it("fires for first 20 holds (every-1 tier)", () => {
    for (let i = 1; i <= 20; i++) {
      const d = decideHoldAffirmation();
      expect(d.show).toBe(true);
      if (d.show) {
        expect(d.kind).toBe("pasted_via_hold");
        expect(d.text).toBe("✦ Pasted");
        expect(d.selects).toBe(i);
      }
    }
  });

  it("decays alongside the copy-side affirmation tiers", () => {
    for (let i = 0; i < 20; i++) decideHoldAffirmation();
    let shown = 0;
    for (let i = 21; i <= 50; i++) {
      if (decideHoldAffirmation().show) shown++;
    }
    expect(shown).toBe(10);
  });

  it("stops firing after 200 holds", () => {
    for (let i = 0; i < 200; i++) decideHoldAffirmation();
    const d = decideHoldAffirmation();
    expect(d.show).toBe(false);
    if (!d.show) expect(d.reason).toBe("past_decay_horizon");
  });

  it("hold counter is independent of the copy-side selects counter", () => {
    for (let i = 0; i < 5; i++) decideAffirmation();
    for (let i = 0; i < 3; i++) decideHoldAffirmation();
    const s = readStats();
    expect(s.selects).toBe(5);
    expect(s.holds).toBe(3);
  });
});

describe("decideHoldDiscovery()", () => {
  it("suppresses when below 10 selects", () => {
    for (let i = 0; i < 9; i++) decideAffirmation();
    const d = decideHoldDiscovery();
    expect(d.show).toBe(false);
    if (!d.show) expect(d.reason).toBe("below_baseline");
  });

  it("suppresses when the user has already used the hold gesture", () => {
    for (let i = 0; i < 20; i++) decideAffirmation();
    decideHoldAffirmation();
    const d = decideHoldDiscovery();
    expect(d.show).toBe(false);
    if (!d.show) expect(d.reason).toBe("already_discovered");
  });

  it("fires once after 10 selects with zero holds", () => {
    for (let i = 0; i < 10; i++) decideAffirmation();
    const d = decideHoldDiscovery();
    expect(d.show).toBe(true);
    if (d.show) {
      expect(d.kind).toBe("hold_discovery");
      expect(d.text).toBe("✦ Press and hold to paste");
    }
  });

  it("never fires twice — even past the cooldown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2030, 0, 1));
    for (let i = 0; i < 10; i++) decideAffirmation();
    expect(decideHoldDiscovery().show).toBe(true);
    // 24h later, still suppressed by the shown-limit cap.
    vi.setSystemTime(new Date(2030, 0, 2));
    const second = decideHoldDiscovery();
    expect(second.show).toBe(false);
    if (!second.show) expect(second.reason).toBe("shown_limit");
    vi.useRealTimers();
  });
});

describe("resetNudgeStats()", () => {
  it("clears all counters", () => {
    for (let i = 0; i < 5; i++) decideAffirmation();
    for (let i = 0; i < 3; i++) decideCorrective();
    for (let i = 0; i < 4; i++) decideHoldAffirmation();
    decideHoldDiscovery();
    resetNudgeStats();
    const s = readStats();
    expect(s.selects).toBe(0);
    expect(s.redundantCopies).toBe(0);
    expect(s.affirmationsShown).toBe(0);
    expect(s.lastCorrectiveAt).toBe(0);
    expect(s.holds).toBe(0);
    expect(s.holdAffirmationsShown).toBe(0);
    expect(s.holdDiscoveryShown).toBe(0);
    expect(s.lastHoldDiscoveryAt).toBe(0);
  });
});
