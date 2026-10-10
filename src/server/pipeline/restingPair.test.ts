// Version 35: which resting HR Recovery scores, and why the sleeping HR (Fitbit's non-REM heart rate) never shares a
// baseline with Google's daily resting HR. On the owner's nights the two sat about 6 bpm apart (60-66 vs 67-71).
import { describe, expect, it } from "vitest";
import { deviation, isTrusted, isUsable, restingHRCfg, update } from "@/core/scoring/baselines";
import type { BaselineState } from "@/core/scoring/types";
import { restingPair } from "./scores";

type Night = { dm: { nonRemHrBpm: number | null; rhrBpm: number | null } | undefined; cache: { sessionRhr: number | null } };
const night = (sleepHr: number | null, daily: number | null, session: number | null = null) =>
  ({ dm: { nonRemHrBpm: sleepHr, rhrBpm: daily }, cache: { sessionRhr: session } }) as unknown as Parameters<typeof restingPair>[1] & Night;

/** A small deterministic generator, so a failure reproduces. */
function rng(seed: number) {
  let s = seed;
  const u = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  return { u, g: () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()) };
}

/** Folds `n` nights of `value()` into a fresh baseline. */
const fold = (n: number, value: () => number | null) => {
  let b: BaselineState | null = null;
  for (let k = 0; k < n; k++) b = update(b, value(), restingHRCfg);
  return b;
};

describe("restingPair (SCORING_VERSION 35)", () => {
  it("sleeping HR with its own baseline once trusted; Google's daily value with its own before; session last", () => {
    const r = rng(1);
    const daily = fold(60, () => 68 + r.g());
    const young = fold(6, () => 62 + r.g());
    const trusted = fold(20, () => 62 + r.g());
    expect(isUsable(young!) && !isTrusted(young!)).toBe(true);
    expect(isTrusted(trusted!)).toBe(true);

    expect(restingPair({ rhrB: daily, sleepHrB: trusted }, night(61, 69))).toMatchObject({ rhr: 61, baseline: trusted, source: "sleep" });
    // A young sleeping-HR baseline waits while Google's is usable...
    expect(restingPair({ rhrB: daily, sleepHrB: young }, night(61, 69))).toMatchObject({ rhr: 69, baseline: daily, source: "daily" });
    // ...but is used at once when Google's has nothing usable either (a new Fitbit-only account).
    expect(restingPair({ rhrB: null, sleepHrB: young }, night(61, 69))).toMatchObject({ rhr: 61, baseline: young, source: "sleep" });
    // A night without a sleeping HR falls back to the daily pair, then to Pulse's session estimate.
    expect(restingPair({ rhrB: daily, sleepHrB: trusted }, night(null, 69))).toMatchObject({ rhr: 69, baseline: daily, source: "daily" });
    expect(restingPair({ rhrB: daily, sleepHrB: trusted }, night(null, null, 58))).toMatchObject({ rhr: 58, baseline: daily, source: "session" });
    expect(restingPair({ rhrB: daily, sleepHrB: trusted }, night(null, null, null))).toMatchObject({ rhr: null, source: null });
    // Both readings are always reported, for each baseline's fold.
    expect(restingPair({ rhrB: daily, sleepHrB: young }, night(61, 69))).toMatchObject({ sleepHr: 61, dailyRhr: 69 });
  });

  it("the switch to sleeping HR moves no one's resting-HR z; one mixed baseline would (60 people, 6 bpm apart)", () => {
    // 90 nights of Google's daily resting HR only (a Health Connect phone or an older band), then a Fitbit that also
    // reports a non-REM HR about 6 bpm lower. Each person: their own level, night-to-night noise like the owner's
    // (SD about 1.5-2 bpm). The measure: the mean |z| over the first two weeks after the switch.
    const switchZ: number[] = [];
    const mixedZ: number[] = [];
    const firstNights = { kept: [] as number[], mixed: [] as number[] }; // signed z, nights 90-92
    const steady: number[] = [];
    for (let p = 0; p < 60; p++) {
      const r = rng(100 + p);
      const level = 60 + 12 * r.u();
      const gap = 5 + 2 * r.u();
      let rhrB: BaselineState | null = null;
      let sleepHrB: BaselineState | null = null;
      let mixed: BaselineState | null = null;
      for (let n = 0; n < 150; n++) {
        const daily = level + 1.4 * r.g();
        const sleepHr = n >= 90 ? level - gap + 2 * r.g() : null;
        const pair = restingPair({ rhrB, sleepHrB }, night(sleepHr, daily));
        const mixedValue = sleepHr ?? daily; // the naive rule: one series, whichever reading the night has
        if (n >= 90 && n < 104) {
          if (pair.rhr != null && pair.baseline && isUsable(pair.baseline)) switchZ.push(Math.abs(deviation(pair.rhr, pair.baseline).z));
          if (mixed && isUsable(mixed)) mixedZ.push(Math.abs(deviation(mixedValue, mixed).z));
          if (n < 93 && pair.rhr != null && pair.baseline && mixed) {
            firstNights.kept.push(deviation(pair.rhr, pair.baseline).z);
            firstNights.mixed.push(deviation(mixedValue, mixed).z);
          }
        }
        if (n >= 130 && pair.rhr != null && pair.baseline) {
          expect(pair.source).toBe("sleep");
          steady.push(Math.abs(deviation(pair.rhr, pair.baseline).z));
        }
        rhrB = update(rhrB, pair.dailyRhr, restingHRCfg);
        sleepHrB = update(sleepHrB, pair.sleepHr, restingHRCfg);
        mixed = update(mixed, mixedValue, restingHRCfg);
      }
    }
    const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
    // Measured (version 36): mean |z| 0.82 over the two switch weeks with the rule, 2.85 with one mixed baseline (3.5x);
    // 0.80 once settled on the sleeping HR, which is what calibrated z gives (E|z| = 0.80 for a standard normal). On the
    // first three switch nights the mixed baseline reads a resting-HR drop of 3.9 SD (a falsely great Recovery); the
    // rule's mean z there is 0.06. Version 35's fixed 2 bpm floor muted every z: 0.46, 1.45, 0.63, −2.05 and 0.03.
    expect(mean(switchZ)).toBeLessThan(0.95);
    expect(mean(mixedZ)).toBeGreaterThan(2.5 * mean(switchZ));
    expect(Math.abs(mean(firstNights.kept))).toBeLessThan(0.5);
    expect(mean(firstNights.mixed)).toBeLessThan(-2.5);
    expect(mean(steady)).toBeLessThan(0.95);
  });
});
