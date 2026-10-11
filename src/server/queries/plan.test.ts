// planVM: what the Sleep Planner shows (SCORING_VERSION 24: bounded time in bed). Built from the real sleepPlan.
import { describe, expect, it } from "vitest";
import { sleepPlan, type SleepPlannerInput, type WakeNight } from "@/core/algorithms/sleepPlanner";
import { PLAN_EFFICIENCY_NOTE, planVM, type DayRow, type QueryCtx } from "./common";

const ctx = { timeZone: "UTC" } as QueryCtx;
const nights = (efficiency: number): WakeNight[] =>
  Array.from({ length: 14 }, (_, i) => ({ day: new Date(Date.UTC(2026, 8, 17 + i)).toISOString().slice(0, 10), wakeMin: 420, efficiency }));
const vm = (over: Partial<SleepPlannerInput>) => {
  const plan = sleepPlan({ baselineNeedHours: 8, todayLoad: null, typicalSession: null, debtMin: 0, napMin: 0, nights: nights(0.9), wakeDay: "2026-10-01", age: 35, ...over });
  const row = { sleepPlanner: { reason: null, wakeDay: "2026-10-01", nights: 14, ...plan } } as unknown as DayRow;
  const m = planVM(ctx, row, true);
  if (m.value === null) throw new Error("no plan");
  return m.value;
};

describe("planVM (SCORING_VERSION 24)", () => {
  it("uncapped: each plan's share of need is its share, and there are no notes", () => {
    const v = vm({});
    expect(v.plans.map((p) => p.needPct)).toEqual([100, 85, 70]);
    expect(v).toMatchObject({ efficiencyFloored: false, capped: false, inBedCapMin: 600, notes: [] });
  });

  it("low efficiency: the bedtime plans on 85 %, says why, and still delivers the need shares", () => {
    const v = vm({ nights: nights(0.65) });
    expect(v.efficiencyFloored).toBe(true);
    expect(v.notes).toEqual([PLAN_EFFICIENCY_NOTE]);
    expect(v.plans.map((p) => p.needPct)).toEqual([100, 85, 70]);
    // 480 / 0.85 = 564.7 min before 07:00: 21:35 (version 23: 480 / 0.65 = 12.3 h, 18:42).
    expect(v.plans[0].bedtimeAt).toBe(Date.UTC(2026, 9, 1, 7) - Math.round((480 / 0.85) * 60) * 1000);
  });

  it("capped: the captions show the need share actually planned, and a note gives the cap", () => {
    const v = vm({ baselineNeedHours: 9.5, debtMin: 300, nights: nights(0.6), age: 70 });
    expect(v.capped).toBe(true);
    // 9 h in bed at 85 % is 459 min asleep of a 630-min need: 73 %, then 85 % and 70 % of that.
    expect(v.plans.map((p) => p.needPct)).toEqual([73, 62, 51]);
    expect(v.notes).toEqual([PLAN_EFFICIENCY_NOTE, "Time in bed is capped at 9 h for your age."]);
  });
});

describe("planVM around midnight (SCORING_VERSION 41)", () => {
  it("a 00:00 wake: the wake at midnight starting the wake day, bedtimes the afternoon before", () => {
    const late = Array.from({ length: 14 }, (_, i) => ({ day: new Date(Date.UTC(2026, 8, 17 + i)).toISOString().slice(0, 10), wakeMin: i % 2 ? 20 : 1420, efficiency: 0.9 }));
    const v = vm({ nights: late });
    expect(v.wakeAt).toBe(Date.UTC(2026, 9, 1, 0, 0));
    // 480 / 0.9 = 533.3 min in bed: 15:07 on Sep 30 (version 40: wake 12:00 on Oct 1, bedtime 03:07).
    expect(v.plans[0].bedtimeAt).toBe(Date.UTC(2026, 9, 1) - Math.round((480 / 0.9) * 60) * 1000);
  });
});

describe("planVM after a nap (SCORING_VERSION 42)", () => {
  it("a 1 h 50 min nap plans the baseline (version 41: 5 h 40 min of a 7.5 h need), and says why", () => {
    const v = vm({ baselineNeedHours: 7.5, napMin: 110 });
    expect(v.needMin).toBeCloseTo(450, 9);
    expect(v.parts).toMatchObject({ napMin: 0, napAsleepMin: 110 });
    expect(v.notes).toEqual(["Today’s 1 h 50 min nap covers your extra need, not your night’s sleep."]);
    // 450 / 0.9 = 500 min before 07:00: 22:40 (version 41: 340 / 0.9 = 377.8 min, 00:42).
    expect(v.plans[0].bedtimeAt).toBe(Date.UTC(2026, 9, 1, 7) - 500 * 60 * 1000);
  });

  it("a nap the extras absorb adds no note; an hour-long one shows as 1 h", () => {
    expect(vm({ debtMin: 100, napMin: 15 }).notes).toEqual([]);
    expect(vm({ napMin: 60 }).notes).toEqual(["Today’s 1 h nap covers your extra need, not your night’s sleep."]);
  });
});
