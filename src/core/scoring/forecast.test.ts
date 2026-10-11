import { describe, expect, it } from "vitest";
import {
  clamp,
  forecast,
  lag1Autocorrelation,
  levelPriorNights,
  mean,
  phiIllness,
  phiMax,
  phiPrior,
  phiPriorNights,
  minBandPoints,
  minBaselineNights,
  sampleSD,
  sleepNudge,
  solidSleepNights,
  strainAdjCap,
  strainPointsPerRecovery,
  thinBandPoints,
} from "./forecast";
import { logisticK, logisticScore, logisticZ0, sleepPerfScale, wSleep } from "./recovery";
import { toStrainScale, trimpToStrain } from "./strain";

const fill = (n: number, v: number) => Array<number>(n).fill(v);
// Version 38: a flat history at 58 (the population mean the level is held toward) keeps the level and forecast at 58.
const steadyCharge = fill(14, 58);
/** A typical training session of 118 TRIMP (Strain 11.3). */
const SESSION = 118;
const steady = { recentCharge: steadyCharge, typicalSession: SESSION };

describe("RecoveryForecastTest", () => {
  it("null until enough baseline", () => {
    expect(forecast({ recentCharge: fill(minBaselineNights - 1, 60), todayLoad: SESSION})).toBeNull();
    expect(forecast({ recentCharge: fill(minBaselineNights, 60), todayLoad: null})).not.toBeNull();
  });

  it("empty charge is null", () => {
    expect(forecast({ recentCharge: [], todayLoad: SESSION})).toBeNull();
  });

  it("neutral day lands on baseline", () => {
    const f = forecast({ ...steady, todayLoad: SESSION})!;
    expect(f.baseline).toBeCloseTo(58, 9);
    expect(f.charge).toBeCloseTo(58, 9);
    expect(f.nights).toBe(14);
  });

  it("a harder day than your typical session lowers; an easier day never raises (version 12; noop raised it)", () => {
    expect(forecast({ ...steady, todayLoad: 2 * SESSION})!.charge).toBeLessThan(58);
    expect(forecast({ ...steady, todayLoad: 9})!.charge).toBe(58);
  });

  it("strain adjustment is capped", () => {
    const f = forecast({ ...steady, todayLoad: 1e6})!;
    expect(f.charge).toBe(58 - strainAdjCap);
  });

  it("strain term drops without a typical session", () => {
    const f = forecast({ recentCharge: steadyCharge, typicalSession: null, todayLoad: 1e6})!;
    expect(f.charge).toBeCloseTo(58, 9);
  });

  it("version 38 (R9): a week of poor sleep lowers tomorrow by what Recovery's sleep term would; a usual week is 0", () => {
    const usual = fill(28, 0.85);
    const poorWeek = [...fill(21, 0.85), ...fill(7, 0.73)]; // 12 points under the usual: one unit of the sleep scale
    const f0 = forecast({ ...steady, todayLoad: null, sleepPerfs: usual })!;
    expect(f0.sleepAdj).toBeCloseTo(0, 12);
    expect(f0.expectedSleepPerf).toBeCloseTo(0.85, 12);
    const f = forecast({ ...steady, todayLoad: null, sleepPerfs: poorWeek })!;
    // By hand: centre = mean of the last 28 = 0.82; expected 0.73; z = −0.75 sleep-scale units; × 0.15 through the logistic.
    const centre = (21 * 0.85 + 7 * 0.73) / 28;
    const zSleep = (0.73 - centre) / sleepPerfScale;
    const z58 = logisticZ0 - Math.log(100 / 58 - 1) / logisticK;
    expect(f.sleepAdj).toBeCloseTo(logisticScore(z58 + wSleep * zSleep) - 58, 9);
    expect(f.sleepAdj).toBeLessThan(-2);
    expect(f.charge).toBe(Math.round(58 + f.sleepAdj));
    // A good week raises it, symmetrically through the same term.
    expect(forecast({ ...steady, todayLoad: null, sleepPerfs: [...fill(21, 0.85), ...fill(7, 0.95)] })!.sleepAdj).toBeGreaterThan(0);
  });

  it("version 38 (R9): sleep debt and naps don't enter the forecast at all", () => {
    // The old wiring passed the Sleep Planner's advice (need + 20 % of debt − naps) as "planned sleep": 600 min of debt
    // gave +4 and a 90-minute nap −3. The forecast now takes no debt or nap input; only past nights' Sleep Performance.
    const f = forecast({ ...steady, todayLoad: null, sleepPerfs: fill(28, 0.85) })!;
    expect(Object.keys(f)).not.toContain("plannedSleepHours");
    expect(f.charge).toBe(58);
  });

  it("no sleep nudge with fewer than 3 nights of Sleep Performance", () => {
    const f = forecast({ ...steady, todayLoad: null, sleepPerfs: [0.5, 0.5] })!;
    expect(f.sleepAdj).toBe(0);
    expect(f.expectedSleepPerf).toBeNull();
    expect(sleepNudge(58, [0.5, 0.5, 0.5]).expectedSleepPerf).toBeCloseTo(0.5, 12);
  });

  it("charge and band stay in range", () => {
    const f = forecast({ recentCharge: fill(14, 8), typicalSession: SESSION, todayLoad: 1e6})!;
    expect(f.charge).toBeGreaterThanOrEqual(0);
    expect(f.charge).toBeLessThanOrEqual(100);
    expect(f.low).toBeGreaterThanOrEqual(0);
    expect(f.high).toBeLessThanOrEqual(100);
  });

  it("thin baseline widens band and is building", () => {
    const f = forecast({ recentCharge: fill(6, 60), typicalSession: SESSION, todayLoad: SESSION})!;
    expect(f.band).toBeCloseTo(minBandPoints + thinBandPoints, 9);
    expect(f.confidence).toBe("building");
  });

  it("full baseline with a week of sleep is solid", () => {
    const f = forecast({ ...steady, todayLoad: SESSION, sleepPerfs: fill(solidSleepNights, 0.85) })!;
    expect(f.confidence).toBe("solid");
    expect(f.band).toBeCloseTo(minBandPoints, 9);
  });

  it("full baseline but under a week of sleep is building", () => {
    expect(forecast({ ...steady, todayLoad: SESSION, sleepPerfs: fill(solidSleepNights - 1, 0.85) })!.confidence).toBe("building");
  });

  it("version 38: tomorrow leans from your level toward today by φ̂ (no trend term)", () => {
    // 30 days alternating 50 / 70 (mean 60, r1 strongly negative → φ̂ clamped to 0) then today.
    const alt = Array.from({ length: 30 }, (_, i) => (i % 2 ? 70 : 50));
    const level = (30 * 60 + levelPriorNights * 58) / (30 + levelPriorNights);
    const f0 = forecast({ recentCharge: alt, todayLoad: null})!;
    expect(f0.phi).toBe(0);
    expect(f0.baseline).toBeCloseTo(level, 9);
    expect(f0.charge).toBe(Math.round(level));
    // A slow wave (strong persistence): today below the level pulls tomorrow below it by φ̂ × the gap.
    const wave = Array.from({ length: 60 }, (_, i) => 60 + 15 * Math.sin(i / 6));
    const f = forecast({ recentCharge: wave, todayLoad: null})!;
    const lvl = (60 * mean(wave) + levelPriorNights * 58) / (60 + levelPriorNights);
    const r1 = lag1Autocorrelation(wave);
    const phi = Math.min(phiMax, (60 * r1 + phiPriorNights * phiPrior) / (60 + phiPriorNights));
    expect(f.phi).toBeCloseTo(phi, 12);
    expect(f.charge).toBe(Math.round(lvl + phi * (wave.at(-1)! - lvl)));
    // A falling run no longer gets pushed back up past today (version 37's "−slope" did).
    const falling = Array.from({ length: 14 }, (_, i) => 80 - 2 * i);
    const g = forecast({ recentCharge: falling, todayLoad: null})!;
    expect(g.charge).toBeLessThanOrEqual(Math.round(g.baseline));
    expect(g.charge).toBeGreaterThanOrEqual(falling.at(-1)!);
  });

  it("φ̂ is held toward 0.3 on a short history and kept within [0, 0.6]", () => {
    const short = [40, 42, 44, 46, 48]; // r1 by hand: mean 44, Σ(x−m)² = 40, Σ lag products = (−2·−4) + (0·−2) + (2·0) + (4·2) = 16 → 0.4
    expect(lag1Autocorrelation(short)).toBeCloseTo(0.4, 12);
    const f = forecast({ recentCharge: short, todayLoad: null})!;
    expect(f.phi).toBeCloseTo((5 * 0.4 + phiPriorNights * phiPrior) / (5 + phiPriorNights), 12);
    const smooth = Array.from({ length: 60 }, (_, i) => 40 + i * 0.5); // r1 near 1
    expect(forecast({ recentCharge: smooth, todayLoad: null})!.phi).toBe(phiMax);
    expect(lag1Autocorrelation([5, 5, 5])).toBe(0);
    expect(lag1Autocorrelation([1, 2])).toBe(0);
  });

  it("while the illness hold runs, tomorrow stays closer to today (φ̂ at least 0.6)", () => {
    const sick = [...fill(40, 60), 30, 25];
    const plain = forecast({ recentCharge: sick, todayLoad: null})!;
    const held = forecast({ recentCharge: sick, illnessHeld: true, todayLoad: null})!;
    expect(held.phi).toBe(Math.max(plain.phi, phiIllness));
    expect(held.charge).toBeLessThan(plain.charge);
  });

  it("stat helpers", () => {
    expect(mean([2, 4, 6])).toBeCloseTo(4, 9);
    expect(mean([])).toBe(0);
    expect(sampleSD([10])).toBe(0);
    expect(sampleSD([2, 4, 6])).toBeCloseTo(2, 9);
  });

  it("clamp preserves the input's signed zero at inclusive bounds", () => {
    const cases: [number, number, number][] = [
      [+0, -0, 1],
      [-0, +0, 1],
      [+0, -1, -0],
      [-0, -1, +0],
    ];
    for (const [x, lo, hi] of cases) expect(Object.is(clamp(x, lo, hi), x)).toBe(true);
    expect(clamp(-1.01, -1, 1)).toBe(-1);
    expect(clamp(0.25, -1, 1)).toBe(0.25);
    expect(clamp(1.01, -1, 1)).toBe(1);
  });
});

describe("strain nudge: one-sided against your typical session (SCORING_VERSION 12)", () => {
  const S = (t: number) => toStrainScale(trimpToStrain(t));
  const nudge = (todayLoad: number | null, typicalSession: number | null = SESSION) =>
    forecast({ recentCharge: steadyCharge, typicalSession, todayLoad})!.charge - 58;

  it("is never positive: a rest day and a not-yet-trained morning leave tomorrow alone", () => {
    // noop's two-sided term gave both +12 against an average day that includes rest days.
    for (const load of [0, 2, 5, 9, 60, SESSION]) expect(nudge(load)).toBe(0);
  });

  it(`is −${strainPointsPerRecovery} per Strain point above the session: 2× ≈ −5, 3× ≈ −8`, () => {
    expect(nudge(2 * SESSION)).toBe(-Math.round(strainPointsPerRecovery * (S(2 * SESSION) - S(SESSION))));
    expect(nudge(2 * SESSION)).toBe(-5);
    expect(nudge(3 * SESSION)).toBe(-8);
  });

  it(`is capped at −${strainAdjCap}`, () => {
    expect(nudge(50 * SESSION)).toBe(-strainAdjCap);
  });

  it("means the same for light, moderate, heavy and daily trainers (Strain-point differences are load ratios)", () => {
    for (const session of [50, 118, 300, 150]) {
      expect(nudge(session, session)).toBe(0);
      expect(nudge(2 * session, session)).toBeCloseTo(nudge(2 * SESSION), 0);
      expect(nudge(3 * session, session)).toBeCloseTo(nudge(3 * SESSION), 0);
    }
  });

  it("an evening session: 0 all day until the load passes the usual session", () => {
    // Version 11: +12 at 08:00, 12:00 and 17:00, then −9 after the session (a 21-point swing).
    expect([2, 5, 8].map((so) => nudge(so))).toEqual([0, 0, 0]);
    expect(nudge(120)).toBe(0);
  });
});
