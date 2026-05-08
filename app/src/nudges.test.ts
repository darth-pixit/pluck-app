import { beforeEach, describe, expect, it, vi } from "vitest";
import { decideAffirmation, decideCorrective, readStats, resetNudgeStats } from "./nudges";

beforeEach(() => {
  resetNudgeStats();
});

describe("decideAffirmation()", () => {
  it("fires for first 5 captures (every-1 tier)", () => {
    for (let i = 1; i <= 5; i++) {
      const d = decideAffirmation();
      expect(d.show).toBe(true);
      if (d.show) {
        expect(d.kind).toBe("affirmation");
        expect(d.text).toBe("✦ Snagged");
        expect(d.selects).toBe(i);
      }
    }
  });

  it("decays to every-2 between 6 and 20", () => {
    // First 5 are guaranteed.
    for (let i = 0; i < 5; i++) decideAffirmation();
    let shown = 0;
    for (let i = 6; i <= 20; i++) {
      if (decideAffirmation().show) shown++;
    }
    // (selects-1) % 2 === 0 fires for selects in {7, 9, 11, 13, 15, 17, 19} = 7
    expect(shown).toBe(7);
  });

  it("decays to every-5 between 21 and 50", () => {
    for (let i = 0; i < 20; i++) decideAffirmation();
    let shown = 0;
    for (let i = 21; i <= 50; i++) {
      if (decideAffirmation().show) shown++;
    }
    // 21, 26, 31, 36, 41, 46 = 6 (every (selects-1) % 5 === 0)
    expect(shown).toBe(6);
  });

  it("stops firing after 200", () => {
    for (let i = 0; i < 200; i++) decideAffirmation();
    const d = decideAffirmation();
    expect(d.show).toBe(false);
    if (!d.show) expect(d.reason).toBe("past_decay_horizon");
  });

  it("increments selects counter regardless of show outcome", () => {
    for (let i = 0; i < 7; i++) decideAffirmation();
    expect(readStats().selects).toBe(7);
  });

  it("only increments affirmations counter on show", () => {
    for (let i = 0; i < 5; i++) decideAffirmation();
    expect(readStats().affirmationsShown).toBe(5);
    decideAffirmation(); // selects=6, every-2 tier, (6-1)%2===1 -> skip
    expect(readStats().affirmationsShown).toBe(5);
    decideAffirmation(); // selects=7, (7-1)%2===0 -> show
    expect(readStats().affirmationsShown).toBe(6);
  });

  it("returns reason 'decay_skip' when in tier but skipped", () => {
    for (let i = 0; i < 5; i++) decideAffirmation();
    const d = decideAffirmation(); // selects=6 in every-2; (6-1)%2 != 0
    expect(d.show).toBe(false);
    if (!d.show) expect(d.reason).toBe("decay_skip");
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
      expect(d.text).toBe("Already copied — no Cmd+C needed");
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

describe("resetNudgeStats()", () => {
  it("clears all counters", () => {
    for (let i = 0; i < 5; i++) decideAffirmation();
    for (let i = 0; i < 3; i++) decideCorrective();
    resetNudgeStats();
    const s = readStats();
    expect(s.selects).toBe(0);
    expect(s.redundantCopies).toBe(0);
    expect(s.affirmationsShown).toBe(0);
    expect(s.lastCorrectiveAt).toBe(0);
  });
});
