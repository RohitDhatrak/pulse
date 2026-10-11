// Version 35: which resting HR Recovery scores, and why the sleeping HR (Fitbit's non-REM heart rate) never shares a
// baseline with Google's daily resting HR. On the owner's nights the two sat about 6 bpm apart (60-66 vs 67-71).
import { describe, expect, it } from "vitest";
import { deviation, hrvCfg, isTrusted, isUsable, restingHRCfg, update } from "@/core/scoring/baselines";
import { recoveryFromStates } from "@/core/scoring/recovery";
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

/** Version 38's rule, kept for comparison: Google's daily value, else Pulse's session estimate, shares `rhrB`. */
function restingPairV38(f: { rhrB: BaselineState | null; sleepHrB: BaselineState | null }, d: { sleepHr: number | null; google: number | null; session: number | null }) {
  const dailyRhr = d.google ?? d.session;
  const sB = f.sleepHrB;
  if (d.sleepHr != null && sB && isUsable(sB) && (isTrusted(sB) || !(f.rhrB && isUsable(f.rhrB)))) return { rhr: d.sleepHr, baseline: sB, sleepHr: d.sleepHr, dailyRhr };
  return { rhr: dailyRhr, baseline: f.rhrB, sleepHr: d.sleepHr, dailyRhr };
}

describe("restingPair (SCORING_VERSION 35)", () => {
  it("sleeping HR with its own baseline once trusted; Google’s daily value with its own before; never the session estimate (v39)", () => {
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
    // A night without a sleeping HR falls back to the daily pair.
    expect(restingPair({ rhrB: daily, sleepHrB: trusted }, night(null, 69))).toMatchObject({ rhr: 69, baseline: daily, source: "daily" });
    // Version 39: Pulse's session estimate never stands in for Google's value: no sleeping HR either → no term.
    expect(restingPair({ rhrB: daily, sleepHrB: trusted }, night(null, null, 58))).toMatchObject({ rhr: null, source: null, dailyRhr: null });
    expect(restingPair({ rhrB: daily, sleepHrB: trusted }, night(null, null, null))).toMatchObject({ rhr: null, source: null });
    // ...and with no Google value a young but usable sleeping-HR baseline is used (version 39; before, the session estimate).
    expect(restingPair({ rhrB: daily, sleepHrB: young }, night(61, null, 58))).toMatchObject({ rhr: 61, baseline: young, source: "sleep", dailyRhr: null });
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

describe("a night without Google's resting HR (SCORING_VERSION 39, audit R10)", () => {
  // 60 people: 60 nights of a phone (Google's daily value only), then a Fitbit, which adds the sleeping HR (Google − 6 ±
  // 2) and Pulse's session estimate (Google − 8.6 ± 1.7, the owner's measurement). Google's value is missing on 15 % of
  // Fitbit nights and the sleeping HR on 20 %. On a night missing Google's value, compare the rule's resting-HR z and a
  // Recovery (HRV at its baseline) with the same night had Google's value been there.
  const hrvB = Array.from({ length: 30 }, (_, k) => 50 + (k % 2 ? 4 : -4)).reduce<BaselineState | null>((b, v) => update(b, v, hrvCfg), null)!;
  const score = (rhr: number | null, rhrB: BaselineState | null) =>
    recoveryFromStates({ hrv: hrvB.baseline, rhr, hrvBaseline: hrvB, rhrBaseline: rhrB && isUsable(rhrB) ? rhrB : null })!;
  const runs = { v38: { z: [] as number[], gap: [] as number[] }, v39: { z: [] as number[], gap: [] as number[] }, centre: [] as number[] };
  for (let p = 0; p < 60; p++) {
    const r = rng(500 + p);
    const level = 58 + 12 * r.u();
    const state = { v38: { rhrB: null as BaselineState | null, sleepHrB: null as BaselineState | null }, v39: { rhrB: null as BaselineState | null, sleepHrB: null as BaselineState | null } };
    const googles: number[] = [];
    for (let n = 0; n < 150; n++) {
      const google = level + 1.4 * r.g();
      const fitbit = n >= 60;
      const missing = fitbit && r.u() < 0.15;
      const sleepHr = fitbit && r.u() >= 0.2 ? google - 6 + 2 * r.g() : null;
      const session = fitbit ? google - 8.6 + 1.7 * r.g() : null;
      const old = restingPairV38(state.v38, { sleepHr, google: missing ? null : google, session });
      const now = restingPair(state.v39, night(sleepHr, missing ? null : google, session));
      if (missing) {
        const oldFull = restingPairV38(state.v38, { sleepHr, google, session });
        const nowFull = restingPair(state.v39, night(sleepHr, google, session));
        if (old.rhr != null && old.baseline && isUsable(old.baseline)) runs.v38.z.push(deviation(old.rhr, old.baseline).z);
        runs.v38.gap.push(score(old.rhr, old.baseline) - score(oldFull.rhr, oldFull.baseline));
        if (now.rhr != null && now.baseline && isUsable(now.baseline)) runs.v39.z.push(deviation(now.rhr, now.baseline).z);
        runs.v39.gap.push(score(now.rhr, now.baseline) - score(nowFull.rhr, nowFull.baseline));
      } else googles.push(google);
      state.v38.rhrB = update(state.v38.rhrB, old.dailyRhr, restingHRCfg);
      state.v38.sleepHrB = update(state.v38.sleepHrB, old.sleepHr, restingHRCfg);
      state.v39.rhrB = update(state.v39.rhrB, now.dailyRhr, restingHRCfg);
      state.v39.sleepHrB = update(state.v39.sleepHrB, now.sleepHr, restingHRCfg);
    }
    runs.centre.push(state.v39.rhrB!.baseline - googles.slice(-40).reduce((a, b) => a + b, 0) / 40);
  }
  const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;

  it("version 38 scored the session estimate against Google's baseline: a falsely low resting HR and a flattering Recovery", () => {
    // Measured: mean z −2.05 on those nights (the session nights far lower; nights with a trusted sleeping HR already used
    // it), Recovery 11.5 points above the same night with Google's value.
    expect(mean(runs.v38.z)).toBeLessThan(-1.5);
    expect(mean(runs.v38.gap)).toBeGreaterThan(8);
  });

  it("version 39 reads such a night like a normal one: the sleeping HR against its own baseline, or no term", () => {
    // Measured: mean z +0.08, Recovery −0.04 points from the same night with Google's value on average.
    expect(Math.abs(mean(runs.v39.z))).toBeLessThan(0.5);
    expect(Math.abs(mean(runs.v39.gap))).toBeLessThan(3);
  });

  it("Google's resting-HR baseline only ever folds Google's values (within 0.28 bpm of their recent mean)", () => {
    expect(Math.max(...runs.centre.map(Math.abs))).toBeLessThan(1);
  });
});
