import { describe, expect, it } from "vitest";
import { personalizedNeedHours } from "../scoring/sleep";
import { toStrainScale, trimpToStrain } from "../scoring/strain";
import { inBedCapHours, isWeekendDay, sleepPlan, sleepPlannerConfig, type SleepPlannerInput, type WakeNight } from "./sleepPlanner";

const iso = (d: number) => new Date(Date.UTC(2026, 8, d)).toISOString().slice(0, 10); // September 2026
/** 14 nights, Sep 17–30: weekdays wake 07:00, weekends 09:00, efficiency 0.9. */
const nights: WakeNight[] = Array.from({ length: 14 }, (_, i) => {
  const day = iso(17 + i);
  return { day, wakeMin: isWeekendDay(day) ? 540 : 420, efficiency: 0.9 };
});
/** Day Strain (0–21) → TRIMP. */
const T = (s: number) => Math.pow(7201, s / 21) - 1;
const S = (t: number) => toStrainScale(trimpToStrain(t));
const input = (over: Partial<SleepPlannerInput> = {}): SleepPlannerInput => ({
  baselineNeedHours: 8,
  todayLoad: T(10),
  typicalSession: T(10),
  debtMin: 0,
  napMin: 0,
  nights,
  wakeDay: "2026-10-01", // a Thursday
  age: 35,
  ...over,
});

describe("sleepPlan need", () => {
  it("no debt and base strain gives need = baseline", () => {
    const p = sleepPlan(input());
    expect(p.needMin).toBeCloseTo(480, 10);
    expect(p.parts).toEqual({ baselineMin: 480, strainMin: 0, debtMin: 0, napMin: 0 });
  });

  it("60 min of debt adds 12 min", () => {
    expect(sleepPlan(input({ debtMin: 60 })).needMin).toBeCloseTo(492, 10);
  });

  it("a 30-minute nap subtracts 30", () => {
    expect(sleepPlan(input({ napMin: 30 })).needMin).toBeCloseTo(450, 10);
  });

  it("adds 0.05 h per Day Strain point above your typical session, never less for a light day", () => {
    expect(sleepPlan(input({ todayLoad: T(16) })).parts.strainMin).toBeCloseTo(6 * 0.05 * 60, 1);
    expect(sleepPlan(input({ todayLoad: T(4) })).parts.strainMin).toBe(0);
    expect(sleepPlan(input({ todayLoad: null })).parts.strainMin).toBe(0);
    expect(sleepPlan(input({ typicalSession: null })).parts.strainMin).toBe(0);
  });
});

describe("sleepPlan bedtimes", () => {
  it("orders 100 % earliest, then 85 %, then 70 %", () => {
    const p = sleepPlan(input());
    expect(p.plans.map((x) => x.share)).toEqual(sleepPlannerConfig.shares);
    const [a, b, c] = p.plans.map((x) => x.bedtimeMin);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    // 480 / 0.9 = 533.3 min in bed before 07:00: 22:07 the evening before.
    expect(a).toBeCloseTo(420 - 480 / 0.9, 8);
    expect(p.plans[0].inBedMin).toBeCloseTo(533.33, 1);
  });

  it("uses weekday and weekend wake times", () => {
    const weekday = sleepPlan(input({ wakeDay: "2026-10-01" }));
    const weekend = sleepPlan(input({ wakeDay: "2026-10-03" })); // a Saturday
    expect(weekday).toMatchObject({ weekend: false, wakeMin: 420 });
    expect(weekend).toMatchObject({ weekend: true, wakeMin: 540 });
    expect(weekend.plans[0].bedtimeMin - weekday.plans[0].bedtimeMin).toBeCloseTo(120, 10);
  });

  it("takes the median wake time and efficiency over the last 14 nights", () => {
    const older = Array.from({ length: 10 }, (_, i) => ({ day: iso(1 + i), wakeMin: 300, efficiency: 0.5 }));
    const odd = nights.map((n, i) => (i === 0 ? { ...n, wakeMin: 480, efficiency: null } : n));
    const p = sleepPlan(input({ nights: [...older, ...odd] }));
    expect(p.wakeMin).toBe(420);
    expect(p.efficiency).toBe(0.9);
  });

  it("falls back to all nights, then to no plan", () => {
    const weekdaysOnly = nights.filter((n) => !isWeekendDay(n.day));
    expect(sleepPlan(input({ nights: weekdaysOnly, wakeDay: "2026-10-03" })).wakeMin).toBe(420);
    const none = sleepPlan(input({ nights: [] }));
    expect(none).toMatchObject({ wakeMin: null, plans: [], efficiency: sleepPlannerConfig.defaultEfficiency });
    expect(none.needMin).toBeCloseTo(480, 10);
  });
});

describe("sleepPlan strain extra: against your typical session (SCORING_VERSION 12)", () => {
  const extra = (todayLoad: number | null, typicalSession: number | null) => sleepPlan(input({ todayLoad, typicalSession })).parts.strainMin;

  it("a rest day, a day still below your session, and a routine session all add 0", () => {
    // Version 11 compared with the average day (rest days included): a routine session added about 8 min.
    for (const load of [0, 9, 60, 118]) expect(extra(load, 118)).toBe(0);
  });

  it("1.5× / 2× / 3× your session add about 3 / 5 / 8 minutes", () => {
    expect(extra(1.5 * 118, 118)).toBeCloseTo(3 * (S(1.5 * 118) - S(118)), 8);
    expect(Math.round(extra(1.5 * 118, 118))).toBe(3);
    expect(Math.round(extra(2 * 118, 118))).toBe(5);
    expect(Math.round(extra(3 * 118, 118))).toBe(8);
  });

  it(`is capped at ${sleepPlannerConfig.maxStrainMin} minutes`, () => {
    expect(extra(1e7, 10)).toBe(sleepPlannerConfig.maxStrainMin);
  });

  it("means the same for light, moderate, heavy, daily and sedentary trainers", () => {
    for (const session of [11, 50, 118, 150, 300]) {
      expect(extra(session, session)).toBe(0);
      expect(extra(2 * session, session)).toBeCloseTo(extra(2 * 118, 118), 0);
    }
  });

  it("a day only adds sleep once it passes your usual session, so a morning plan is not inflated", () => {
    expect([2, 5, 8].map((so) => extra(so, 118))).toEqual([0, 0, 0]);
    expect(extra(240, 118)).toBeGreaterThan(0);
  });
});

describe("a steady 7 h sleeper's plan (SCORING_VERSION 15 sleep need)", () => {
  const sevens = Array.from({ length: 14 }, (_, i) => {
    const day = iso(17 + i);
    return { day, wakeMin: 420, efficiency: 0.88 };
  });
  it("asks for about 7.95 h in bed, bedtime about 23:03 for 07:00 (version 14: about 9.4 h, 21:38)", () => {
    const need = personalizedNeedHours(Array(14).fill(7), 35);
    expect(need).toBe(7);
    const plan = sleepPlan(input({ baselineNeedHours: need, debtMin: 0, nights: sevens }));
    expect(plan.plans[0].inBedMin / 60).toBeCloseTo(7 / 0.88, 6);
    expect(plan.plans[0].bedtimeMin).toBeCloseTo(420 - (7 * 60) / 0.88, 6); // −57.3 min: 23:03 the evening before
    // Version 14: need 8 h and 73 min of debt (+20 % of it): (480 + 14.6) / 0.88 ≈ 9.37 h in bed.
    const v14 = sleepPlan(input({ baselineNeedHours: 8, debtMin: 73, nights: sevens }));
    expect(v14.plans[0].inBedMin / 60).toBeGreaterThan(9.3);
  });
});

describe("SCORING_VERSION 24: time in bed is bounded", () => {
  const at = (efficiency: number | null, n = 14): WakeNight[] => Array.from({ length: n }, (_, i) => ({ day: iso(17 + i), wakeMin: 420, efficiency }));
  /** Version 23: in bed = share × need ÷ median efficiency, unbounded. */
  const v23InBed = (needMin: number, eff: number, share = 1) => (share * needMin) / eff;

  it("plans at no less than 85 % efficiency: 70 % is planned at 85 %", () => {
    const p = sleepPlan(input({ nights: at(0.7) }));
    expect(p.efficiency).toBe(0.7);
    expect(p.planningEfficiency).toBe(0.85);
    expect(p.efficiencyFloored).toBe(true);
    expect(p.plans[0].inBedMin).toBeCloseTo(480 / 0.85, 9); // 9.4 h; version 23: 480 / 0.7 = 11.4 h
    expect(p.plans[0].inBedMin).toBeLessThan(v23InBed(480, 0.7) - 100);
    expect(p.plans[0].sleepMin).toBeCloseTo(480, 9);
  });

  it("at 85 % or more nothing changes: the plan equals version 23's", () => {
    for (const eff of [0.85, 0.9, 0.97]) {
      const p = sleepPlan(input({ nights: at(eff), debtMin: 90 }));
      expect(p.efficiencyFloored).toBe(false);
      expect(p.capped).toBe(false);
      for (const x of p.plans) {
        expect(x.inBedMin).toBeCloseTo(v23InBed(p.needMin, eff, x.share), 9);
        expect(x.sleepMin).toBeCloseTo(x.share * p.needMin, 9);
      }
    }
  });

  it("one glitchy first night at 5 % efficiency: 8.8 h in bed, not 150 h", () => {
    const p = sleepPlan(input({ baselineNeedHours: 7.5, todayLoad: null, nights: at(0.05, 1) }));
    expect(p.plans[0].inBedMin / 60).toBeCloseTo(7.5 / 0.85, 9);
    expect(v23InBed(450, 0.05) / 60).toBe(150);
  });

  it("with no efficiency known, the 0.9 default still applies", () => {
    const p = sleepPlan(input({ nights: at(null) }));
    expect(p.efficiency).toBe(0.9);
    expect(p.planningEfficiency).toBe(0.9);
    expect(p.efficiencyFloored).toBe(false);
  });

  it("the cap follows the NSF 'may be appropriate' upper bound for age, at both edges of each band", () => {
    expect([0, 6, 13].map(inBedCapHours)).toEqual([12, 12, 12]);
    expect([14, 17, 18, 25].map(inBedCapHours)).toEqual([11, 11, 11, 11]);
    expect([26, 40, 64].map(inBedCapHours)).toEqual([10, 10, 10]);
    expect([65, 90].map(inBedCapHours)).toEqual([9, 9]);
    expect(inBedCapHours(null)).toBe(10);
    expect(inBedCapHours(Number.NaN)).toBe(10);
    expect(sleepPlan(input({ age: 70 })).inBedCapMin).toBe(540);
    expect(sleepPlan(input({ age: null })).inBedCapMin).toBe(600);
  });

  it("extreme inputs (need 9.5 h, 300 min debt, maximum strain, 60 %): 10 h in bed at 30, not 18.3 h", () => {
    const p = sleepPlan(input({ baselineNeedHours: 9.5, debtMin: 300, todayLoad: T(21), typicalSession: T(5), nights: at(0.6), age: 30 }));
    expect(v23InBed(p.needMin, 0.6) / 60).toBeCloseTo(1100 / 60, 9); // 18.3 h
    expect(p.capped).toBe(true);
    expect(p.plans[0].inBedMin).toBe(600);
    expect(p.plans[0].bedtimeMin).toBe(-180); // 21:00; version 23: 12:40
  });

  it("capped tiers are shares of the cap: distinct, and each falls short of its need share", () => {
    const p = sleepPlan(input({ baselineNeedHours: 9.5, debtMin: 300, nights: at(0.6), age: 16 }));
    expect(p.capped).toBe(true);
    expect(p.plans.map((x) => x.inBedMin)).toEqual([660, 0.85 * 660, 0.7 * 660].map((m) => expect.closeTo(m, 9)));
    const [a, b, c] = p.plans.map((x) => x.bedtimeMin);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    for (const x of p.plans) {
      expect(x.sleepMin).toBeCloseTo(x.inBedMin * 0.85, 9);
      expect(x.sleepMin).toBeLessThan(x.share * p.needMin);
    }
  });

  it("need and its parts don't change (the Recovery forecast reads needMin)", () => {
    const over = { baselineNeedHours: 9.5, debtMin: 300, todayLoad: T(21), typicalSession: T(5), napMin: 20, nights: at(0.6) };
    const p = sleepPlan(input(over));
    expect(p.parts).toEqual({ baselineMin: 570, strainMin: 30, debtMin: 60, napMin: 20 });
    expect(p.needMin).toBe(640);
  });
});
