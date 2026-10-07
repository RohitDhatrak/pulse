import { describe, expect, it } from "vitest";
import {
  clamp,
  defaultNeedHours,
  forecast,
  leastSquaresSlope,
  mean,
  minBandPoints,
  minBaselineNights,
  sampleSD,
  solidNeedNights,
  strainAdjCap,
  strainPointsPerRecovery,
  thinBandPoints,
} from "./forecast";
import { toStrainScale, trimpToStrain } from "./strain";

const fill = (n: number, v: number) => Array<number>(n).fill(v);
const steadyCharge = fill(14, 60);
/** A typical training session of 118 TRIMP (Strain 11.3). */
const SESSION = 118;
const steady = { recentCharge: steadyCharge, typicalSession: SESSION };

describe("RecoveryForecastTest", () => {
  it("null until enough baseline", () => {
    expect(forecast({ recentCharge: fill(minBaselineNights - 1, 60), todayLoad: SESSION, plannedSleepHours: 8 })).toBeNull();
    expect(forecast({ recentCharge: fill(minBaselineNights, 60), todayLoad: null, plannedSleepHours: 8 })).not.toBeNull();
  });

  it("empty charge is null", () => {
    expect(forecast({ recentCharge: [], todayLoad: SESSION, plannedSleepHours: 8 })).toBeNull();
  });

  it("neutral day lands on baseline", () => {
    const f = forecast({ ...steady, todayLoad: SESSION, plannedSleepHours: defaultNeedHours })!;
    expect(f.baseline).toBeCloseTo(60, 9);
    expect(f.charge).toBeCloseTo(60, 9);
    expect(f.nights).toBe(14);
  });

  it("a harder day than your typical session lowers; an easier day never raises (version 12; noop raised it)", () => {
    expect(forecast({ ...steady, todayLoad: 2 * SESSION, plannedSleepHours: defaultNeedHours })!.charge).toBeLessThan(60);
    expect(forecast({ ...steady, todayLoad: 9, plannedSleepHours: defaultNeedHours })!.charge).toBe(60);
  });

  it("strain adjustment is capped", () => {
    const f = forecast({ ...steady, todayLoad: 1e6, plannedSleepHours: defaultNeedHours })!;
    expect(f.charge).toBe(60 - strainAdjCap);
  });

  it("strain term drops without a typical session", () => {
    const f = forecast({ recentCharge: steadyCharge, typicalSession: null, todayLoad: 1e6, plannedSleepHours: defaultNeedHours })!;
    expect(f.charge).toBeCloseTo(60, 9);
  });

  it("short sleep lowers forecast", () => {
    expect(forecast({ ...steady, todayLoad: SESSION, plannedSleepHours: 4 })!.charge).toBeLessThan(60);
  });

  it("oversleep help is capped", () => {
    const plenty = forecast({ ...steady, todayLoad: SESSION, plannedSleepHours: 12 })!;
    const justOver = forecast({ ...steady, todayLoad: SESSION, plannedSleepHours: 10 })!;
    expect(plenty.charge).toBeCloseTo(justOver.charge, 9);
  });

  it("negative sleep treated as zero", () => {
    expect(forecast({ ...steady, todayLoad: SESSION, plannedSleepHours: -3 })!.plannedSleepHours).toBe(0);
  });

  it("charge and band stay in range", () => {
    const f = forecast({ recentCharge: fill(14, 8), typicalSession: SESSION, todayLoad: 1e6, plannedSleepHours: 0 })!;
    expect(f.charge).toBeGreaterThanOrEqual(0);
    expect(f.charge).toBeLessThanOrEqual(100);
    expect(f.low).toBeGreaterThanOrEqual(0);
    expect(f.high).toBeLessThanOrEqual(100);
  });

  it("thin baseline widens band and is building", () => {
    const f = forecast({ recentCharge: fill(6, 60), typicalSession: SESSION, todayLoad: SESSION, plannedSleepHours: 8 })!;
    expect(f.band).toBeCloseTo(minBandPoints + thinBandPoints, 9);
    expect(f.confidence).toBe("building");
  });

  it("full baseline with informed need is solid", () => {
    const f = forecast({ ...steady, todayLoad: SESSION, plannedSleepHours: 8, needNights: solidNeedNights })!;
    expect(f.confidence).toBe("solid");
    expect(f.band).toBeCloseTo(minBandPoints, 9);
  });

  it("full baseline but default need is building", () => {
    expect(forecast({ ...steady, todayLoad: SESSION, plannedSleepHours: 8, needNights: 0 })!.confidence).toBe("building");
  });

  it("downswing is damped", () => {
    const falling = Array.from({ length: 14 }, (_, i) => 80 - 2 * i);
    const f = forecast({ recentCharge: falling, typicalSession: SESSION, todayLoad: SESSION, plannedSleepHours: 8 })!;
    expect(f.charge).toBeGreaterThan(falling.at(-1)!);
  });

  it("stat helpers", () => {
    expect(mean([2, 4, 6])).toBeCloseTo(4, 9);
    expect(mean([])).toBe(0);
    expect(sampleSD([10])).toBe(0);
    expect(sampleSD([2, 4, 6])).toBeCloseTo(2, 9);
    expect(leastSquaresSlope([1, 2, 3, 4])).toBeCloseTo(1, 9);
    expect(leastSquaresSlope([5])).toBe(0);
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
    forecast({ recentCharge: steadyCharge, typicalSession, todayLoad, plannedSleepHours: defaultNeedHours })!.charge - 60;

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
