import { describe, expect, it } from "vitest";
import { type JournalDay, journalImpact, journalImpactConfig, mulberry32, type OutcomeDay, strengthOf, welchEffect } from "./journalImpact";
import { studentTQuantile } from "./stats";

const DAY_MS = 86_400_000;
const START = "2026-07-01";
const day = (i: number) => new Date(Date.parse(`${START}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10);

/** Deterministic noise in [−1, 1). */
let s = 12345;
const noise = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;

// 91 days: alcohol on ~1 in 4 days (next day −15 recovery, −1 HRV z, −8 sleep), coin_flip on a pattern unrelated to the noise.
const N = 91;
const entries: JournalDay[] = [];
const outcomes: OutcomeDay[] = [];
for (let i = 0; i < N; i++) {
  const alcohol = i % 4 === 1;
  entries.push({ day: day(i), tags: { alcohol, coin_flip: (i * 7) % 3 === 0 ? 1 : 0, rare: i === 10 || i === 20 } });
  const drank = (i - 1) % 4 === 1;
  outcomes.push({
    day: day(i),
    recovery: 65 + 12 * noise() - (drank ? 15 : 0),
    hrvZ: 0.6 * noise() - (drank ? 1 : 0),
    sleepPerf: 85 + 6 * noise() - (drank ? 8 : 0),
  });
}
const asOf = day(N - 1);

describe("journalImpact", () => {
  const result = journalImpact(entries, outcomes, asOf);
  const byTag = Object.fromEntries(result.map((t) => [t.tag, t]));

  it("fewer than 5 yes days gives not enough data", () => {
    expect(byTag.rare.status).toBe("not_enough_data");
    expect(byTag.rare.nYes).toBe(2);
    expect(byTag.rare.effects.recovery).toMatchObject({ label: "not_enough_data", delta: null, nYes: 2 });
  });

  it("alcohol-style data gives a clear negative effect whose interval excludes 0", () => {
    const a = byTag.alcohol;
    expect(a.status).toBe("ok");
    expect(a.nYes + a.nNo).toBe(90);
    for (const m of ["recovery", "hrvZ", "sleepPerf"] as const) {
      expect(a.effects[m].label).toBe("negative");
      expect(a.effects[m].ciHigh!).toBeLessThan(0);
      expect(a.effects[m].ciLow!).toBeLessThan(a.effects[m].delta!);
    }
    expect(a.effects.recovery.delta!).toBeCloseTo(-15, -1);
    expect(a.effects.recovery.p!).toBeLessThan(0.001);
    expect(a.effects.recovery.delta!).toBeCloseTo(a.effects.recovery.meanYes! - a.effects.recovery.meanNo!, 12);
  });

  it("an unrelated tag gives no clear effect", () => {
    expect(byTag.coin_flip.status).toBe("ok");
    expect(byTag.coin_flip.effects.recovery.label).toBe("no_clear_effect");
  });

  it("ranks by |Δ recovery|, not-enough-data last", () => {
    expect(result.map((t) => t.tag)).toEqual(["alcohol", "coin_flip", "rare"]);
  });

  it("is deterministic and independent of input order", () => {
    expect(journalImpact([...entries].reverse(), [...outcomes].reverse(), asOf)).toEqual(result);
  });

  it("only looks at the 90 days before asOf", () => {
    const later = journalImpact(entries, outcomes, day(N + 200));
    expect(later).toEqual([]);
  });

  it("a missing next-day outcome drops the day from that metric only", () => {
    const sparse = outcomes.map((o, i) => (i % 2 ? { ...o, hrvZ: null } : o));
    const a = journalImpact(entries, sparse, asOf).find((t) => t.tag === "alcohol")!;
    expect(a.effects.recovery.nYes + a.effects.recovery.nNo).toBe(90);
    expect(a.effects.hrvZ.nYes + a.effects.hrvZ.nNo).toBe(45);
  });
});

// ── Welch interval, false-discovery tiers, illness exclusion (SCORING_VERSION 18) ──────────────────────────────────

/** Entries and outcomes from per-day rows: `tags` on day i, `recovery` the outcome of day i + 1. */
function series(rows: { tags: Record<string, boolean>; recovery: number; hrvZ?: number; sleepPerf?: number }[]) {
  const entries: JournalDay[] = rows.map((r, i) => ({ day: day(i), tags: r.tags }));
  const outcomes: OutcomeDay[] = rows.map((r, i) => ({ day: day(i + 1), recovery: r.recovery, hrvZ: r.hrvZ ?? 0, sleepPerf: r.sleepPerf ?? 85 }));
  return { entries, outcomes, asOf: day(rows.length) };
}

describe("welchEffect", () => {
  it("matches a hand-computed Welch t interval", () => {
    // yes: mean 55, s² 125 → v1 = 25. no: mean 71.667, s² 28.267 → v2 = 4.7111. se = √29.711 = 5.4508.
    // df = 29.711² / (25²/4 + 4.7111²/5) = 5.4935; t = −16.667 / 5.4508 = −3.058 → p ≈ 0.025.
    const e = welchEffect([50, 60, 70, 40, 55], [70, 72, 68, 75, 65, 80]);
    expect(e.meanYes).toBe(55);
    expect(e.meanNo).toBeCloseTo(71.6667, 4);
    expect(e.delta).toBeCloseTo(-16.6667, 4);
    const half = studentTQuantile(0.1, 5.4935) * 5.4508;
    expect(half).toBeGreaterThan(1.943 * 5.4508); // between the df 6 and df 5 table values
    expect(half).toBeLessThan(2.015 * 5.4508);
    expect(e.ciLow!).toBeCloseTo(-16.6667 - half, 2);
    expect(e.ciHigh!).toBeCloseTo(-16.6667 + half, 2);
    expect(e.p!).toBeGreaterThan(0.02);
    expect(e.p!).toBeLessThan(0.03);
    // Alone, a p this size is only "possible": the false-discovery step decides clear.
    expect(e.label).toBe("possible_negative");
  });

  it("is not enough data below 5 per arm, with every number null", () => {
    expect(welchEffect([1, 2, 3, 4], [1, 2, 3, 4, 5])).toEqual({
      nYes: 4, nNo: 5, delta: null, meanYes: null, meanNo: null, ciLow: null, ciHigh: null, p: null, label: "not_enough_data",
    });
  });

  it("constant arms: a difference is exact (p 0), none is p 1", () => {
    expect(welchEffect([60, 60, 60, 60, 60], [70, 70, 70, 70, 70])).toMatchObject({ delta: -10, ciLow: -10, ciHigh: -10, p: 0, label: "possible_negative" });
    expect(welchEffect([60, 60, 60, 60, 60], [60, 60, 60, 60, 60])).toMatchObject({ delta: 0, p: 1, label: "no_clear_effect" });
  });

  it("an interval that crosses 0 is no clear effect", () => {
    expect(welchEffect([50, 70, 60, 40, 80], [55, 65, 60, 45, 75]).label).toBe("no_clear_effect");
  });
});

describe("journalImpact tiers (Benjamini–Hochberg per metric)", () => {
  // A "moderate" tag (every third day) among six null tags; Recovery 60 ± 14 uniform. Seeds and sizes were picked by
  // printing p, so each case sits clearly on its side of the thresholds.
  const build = (seed: number, effect: number) => {
    const rand = mulberry32(seed);
    const rows = Array.from({ length: 90 }, (_, i) => {
      const tags: Record<string, boolean> = { moderate: i % 3 === 0 };
      for (let k = 0; k < 6; k++) tags[`null${k}`] = rand() < 0.3;
      return { tags, recovery: 60 + 14 * (rand() * 2 - 1) - (tags.moderate ? effect : 0) };
    });
    const { entries, outcomes, asOf } = series(rows);
    return Object.fromEntries(journalImpact(entries, outcomes, asOf).map((t) => [t.tag, t.effects.recovery]));
  };

  it("p under 0.1 but above its rank's threshold is possible, not clear", () => {
    const e = build(4, 3).moderate; // p ≈ 0.046; ranked first of 7 it needs ≤ 0.1 / 7 = 0.014
    expect(e.p!).toBeLessThan(0.1);
    expect(e.p!).toBeGreaterThan(0.1 / 7);
    expect(e.ciHigh!).toBeLessThan(0);
    expect(e.label).toBe("possible_negative");
    expect(strengthOf(e.label)).toBe("possible");
  });

  it("p under its threshold is clear", () => {
    const e = build(1, 4).moderate; // p ≈ 0.003
    expect(e.p!).toBeLessThan(0.1 / 7);
    expect(e.label).toBe("negative");
    expect(strengthOf(e.label)).toBe("clear");
  });

  it("each metric is its own family: sleep labels don't change with a strong Recovery effect beside them", () => {
    const sleepLabels = (strongRecovery: number) => {
      const rand = mulberry32(8);
      const rows = Array.from({ length: 90 }, (_, i) => {
        const tags: Record<string, boolean> = { moderate: i % 3 === 0, strong: i % 4 === 0 };
        for (let k = 0; k < 6; k++) tags[`null${k}`] = rand() < 0.3;
        return { tags, recovery: 60 + 14 * (rand() * 2 - 1) - (tags.strong ? strongRecovery : 0), sleepPerf: 85 + 14 * (rand() * 2 - 1) - (tags.moderate ? 4 : 0) };
      });
      const { entries, outcomes, asOf } = series(rows);
      const r = journalImpact(entries, outcomes, asOf);
      return { sleep: Object.fromEntries(r.map((t) => [t.tag, t.effects.sleepPerf.label])), strong: r.find((t) => t.tag === "strong")!.effects.recovery.label };
    };
    const without = sleepLabels(0);
    const withStrong = sleepLabels(25);
    expect(withStrong.strong).toBe("negative");
    expect(withStrong.sleep).toEqual(without.sleep);
    expect(without.sleep.moderate).toBe("possible_negative"); // p ≈ 0.03
  });

  it("every clear effect has an interval that excludes 0", () => {
    for (const e of [...Object.values(build(1, 4)), ...Object.values(build(4, 3))]) if (strengthOf(e.label) === "clear") expect(e.ciHigh! < 0 || e.ciLow! > 0).toBe(true);
  });
});

describe("journalImpact illness exclusion", () => {
  // 60 days; illness on days 20–25 (Recovery −25). "alcohol" is never logged while ill and costs 10 points.
  const rows = Array.from({ length: 60 }, (_, i) => {
    const ill = i >= 20 && i <= 25;
    const alcohol = !ill && i % 4 === 0;
    const sickNext = i + 1 >= 20 && i + 1 <= 25;
    return { tags: { alcohol, illness: ill }, recovery: 60 + (i % 3) - (alcohol ? 10 : 0) - (sickNext ? 25 : 0) };
  });
  const { entries, outcomes, asOf } = series(rows);
  const byTag = Object.fromEntries(journalImpact(entries, outcomes, asOf).map((t) => [t.tag, t]));

  it("drops the pairs next to an ill day from other behaviours, and only those", () => {
    // Ill on 20–25: pairs starting on 19 (ill next day) through 25 are dropped, 7 of 60.
    expect(byTag.alcohol.nYes + byTag.alcohol.nNo).toBe(53);
    expect(byTag.illness.nYes + byTag.illness.nNo).toBe(60);
    expect(byTag.illness.nYes).toBe(6);
  });

  it("removes the illness bias: alcohol's estimate is its true −10", () => {
    expect(byTag.alcohol.effects.recovery.delta!).toBeCloseTo(-10, 0);
    // Without the exclusion the ill days sit in the "no" arm and shrink the effect.
    const keep = journalImpactConfig.excludeAround;
    journalImpactConfig.excludeAround = [];
    try {
      const raw = journalImpact(entries, outcomes, asOf).find((t) => t.tag === "alcohol")!;
      expect(raw.effects.recovery.delta!).toBeGreaterThan(-7.5);
    } finally {
      journalImpactConfig.excludeAround = keep;
    }
  });

  it("illness itself is still analysed", () => {
    expect(byTag.illness.effects.recovery.delta!).toBeLessThan(-15);
  });
});

/**
 * Simulated users (deterministic): 90 days, 8 behaviours with no effect plus one ("real") with a chosen effect on
 * next-day Recovery; Recovery is AR(1) noise (SD 18, lag-1 r 0.4), HRV z follows it, sleep is independent. These are
 * the numbers in docs/algorithms/journal-impact.md.
 */
describe("journalImpact on simulated users", () => {
  type S = { effect: number; freq?: number; ill?: boolean };
  function run(s: S, users = 200) {
    let r = 7;
    const rand = () => ((r = (r * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
    let nullTests = 0, flagged = 0, clear = 0, usersFalseClear = 0, realClear = 0, realAny = 0;
    const estimates: number[] = [];
    for (let u = 0; u < users; u++) {
      const entries: JournalDay[] = [];
      const outcomes: OutcomeDay[] = [];
      let ar = 0, ar2 = 0, prev = false;
      const illStart = Math.floor(rand() * 70) + 10;
      for (let i = 0; i < 92; i++) {
        const ill = !!s.ill && i >= illStart && i < illStart + 6;
        const real = rand() < (s.freq ?? 0.25);
        const tags: Record<string, boolean> = {};
        if (rand() < 0.85) {
          tags.real = ill ? false : real;
          for (let k = 0; k < 8; k++) tags[`n${k}`] = rand() < 0.1 + 0.05 * k;
          if (s.ill) tags.illness = ill;
        }
        ar = 0.4 * ar + Math.sqrt(0.84) * gauss();
        ar2 = 0.3 * ar2 + Math.sqrt(0.91) * gauss();
        const eff = prev ? s.effect : 0;
        prev = !!tags.real;
        entries.push({ day: day(i), tags });
        outcomes.push({ day: day(i), recovery: 58 + 18 * ar + eff + (ill ? -20 : 0), hrvZ: 0.8 * ar + 0.6 * gauss() + eff / 20 + (ill ? -1 : 0), sleepPerf: 88 + 4 * ar2 + (ill ? -3 : 0) });
      }
      let falseClear = false;
      for (const t of journalImpact(entries, outcomes, day(91))) {
        if (t.tag === "illness") continue;
        for (const m of ["recovery", "hrvZ", "sleepPerf"] as const) {
          const e = t.effects[m];
          if (e.label === "not_enough_data") continue;
          const st = strengthOf(e.label);
          if (t.tag === "real") {
            if (m === "recovery") {
              estimates.push(e.delta!);
              if (st === "clear" && e.delta! < 0) realClear++;
              if (st && e.delta! < 0) realAny++;
            }
            if (s.effect !== 0) continue;
          }
          nullTests++;
          if (st) flagged++;
          if (st === "clear") { clear++; falseClear = true; }
        }
      }
      if (falseClear) usersFalseClear++;
    }
    return {
      flagged: flagged / nullTests,
      clear: clear / nullTests,
      usersFalseClear: usersFalseClear / users,
      realClear: realClear / users,
      realAny: realAny / users,
      meanEstimate: estimates.reduce((a, b) => a + b, 0) / estimates.length,
    };
  }

  it("null behaviours: the 90% interval is calibrated (8–12% flagged) and few are clear", () => {
    const r = run({ effect: 0 });
    // The old percentile bootstrap flagged 12.5% (it undercovers with 5–20-day arms); 94% of users saw a false effect.
    expect(r.flagged).toBeGreaterThan(0.08);
    expect(r.flagged).toBeLessThan(0.12);
    expect(r.clear).toBeLessThan(0.03);
    expect(r.usersFalseClear).toBeLessThan(0.4);
  });

  it("a real −15 effect is usually clear, a real −10 at least possible more often than not", () => {
    expect(run({ effect: -15 }).realClear).toBeGreaterThan(0.55);
    expect(run({ effect: -10 }).realAny).toBeGreaterThan(0.55);
  });

  it("estimates are unbiased", () => {
    expect(run({ effect: -10 }).meanEstimate).toBeCloseTo(-10, 0);
  });

  it("an illness week no longer biases a behaviour never logged while ill", () => {
    // Before the exclusion the mean estimate was about −8.8 for a true −10.
    expect(Math.abs(run({ effect: -10, ill: true }).meanEstimate + 10)).toBeLessThan(1);
  });
});

describe("Welch 90% interval coverage with small arms", () => {
  it.each([5, 7, 10])("misses the true difference 8–12%% of the time with %i-day arms", (n) => {
    let r = 3;
    const rand = () => ((r = (r * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
    let miss = 0;
    const trials = 3000;
    for (let i = 0; i < trials; i++) {
      // Unequal sizes and spreads, true difference −4.
      const yes = Array.from({ length: n }, () => 50 + 15 * gauss());
      const no = Array.from({ length: 3 * n }, () => 54 + 20 * gauss());
      const e = welchEffect(yes, no);
      if (e.ciLow! > -4 || e.ciHigh! < -4) miss++;
    }
    expect(miss / trials).toBeGreaterThan(0.08);
    expect(miss / trials).toBeLessThan(0.12);
  });
});
