// The Sleep Planner on simulated sleepers (SCORING_VERSION 24; docs/algorithms/sleep-planner.md § Why version 24).
// 40 people per profile, nights 30–59 of 60, wake about 07:00, need and debt from the real personalizedNeedHours and
// ledger. Durations and efficiencies are assumptions that fit each picture. Deterministic.
import { describe, expect, it } from "vitest";
import { ledger, personalizedNeedHours } from "../scoring/sleep";
import { inBedCapHours, sleepPlan, type WakeNight } from "./sleepPlanner";

type Profile = { hours: number; sd: number; eff: number; age: number };
const PROFILES = {
  healthy: { hours: 7.5, sd: 0.5, eff: 0.9, age: 35 },
  insomnia: { hours: 6, sd: 0.8, eff: 0.7, age: 45 },
  severeInsomnia: { hours: 5, sd: 0.8, eff: 0.6, age: 50 },
  newParent: { hours: 5, sd: 1, eff: 0.72, age: 32 },
  teen: { hours: 6.5, sd: 0.7, eff: 0.8, age: 16 },
  youngLongSleeper: { hours: 9.3, sd: 0.4, eff: 0.9, age: 22 },
  older: { hours: 6.5, sd: 0.6, eff: 0.78, age: 72 },
} satisfies Record<string, Profile>;

const day = (i: number) => new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10);

type Night = { inBedH: number; bedtimeMin: number; v23InBedH: number; floored: boolean; capped: boolean; capH: number };
function simulate(p: Profile, seed: number): Night[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648), s / 2147483648);
  const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
  const out: Night[] = [];
  for (let person = 0; person < 40; person++) {
    const ownEff = p.eff + 0.03 * g();
    const ownHours = p.hours + 0.3 * g();
    const nights: WakeNight[] = [];
    const hours: number[] = [];
    const series: [string, number][] = [];
    for (let i = 0; i < 60; i++) {
      const h = Math.max(2.5, ownHours + p.sd * g());
      nights.push({ day: day(i), wakeMin: 420 + 20 * g(), efficiency: Math.min(0.98, Math.max(0.4, ownEff + 0.04 * g())) });
      hours.push(h);
      series.push([day(i), h * 60]);
      if (i < 30) continue;
      const need = personalizedNeedHours(hours.slice(-28), p.age);
      const plan = sleepPlan({ baselineNeedHours: need, todayLoad: null, typicalSession: null, debtMin: ledger(series.slice(-14), need).magnitudeMin, napMin: 0, nights, wakeDay: day(i + 1), age: p.age });
      out.push({
        inBedH: plan.plans[0].inBedMin / 60,
        bedtimeMin: plan.plans[0].bedtimeMin,
        v23InBedH: plan.needMin / plan.efficiency / 60,
        floored: plan.efficiencyFloored,
        capped: plan.capped,
        capH: inBedCapHours(p.age),
      });
    }
  }
  return out;
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const runs = Object.fromEntries(Object.entries(PROFILES).map(([k, p], i) => [k, simulate(p, 101 + i)])) as Record<keyof typeof PROFILES, Night[]>;

describe("time in bed on simulated sleepers (version 24)", () => {
  it("insomnia: at most 9 h in bed and a median bedtime from 22:00 (version 23: about 10.4 h, 20:36)", () => {
    const r = runs.insomnia;
    expect(mean(r.map((n) => n.v23InBedH))).toBeGreaterThan(10);
    expect(mean(r.map((n) => n.inBedH))).toBeLessThanOrEqual(9);
    expect(median(r.map((n) => n.bedtimeMin))).toBeGreaterThanOrEqual(-120);
  });

  it("severe insomnia and new parents: at most 9.5 h (version 23: about 12.6 and 10.5 h)", () => {
    expect(mean(runs.severeInsomnia.map((n) => n.v23InBedH))).toBeGreaterThan(12);
    expect(mean(runs.severeInsomnia.map((n) => n.inBedH))).toBeLessThanOrEqual(9.5);
    expect(mean(runs.newParent.map((n) => n.v23InBedH))).toBeGreaterThan(10);
    expect(mean(runs.newParent.map((n) => n.inBedH))).toBeLessThanOrEqual(9.5);
  });

  it("a short-sleeping teen is held to 11 h (version 23: about 12 h, some bedtimes before 18:00)", () => {
    expect(mean(runs.teen.map((n) => n.v23InBedH))).toBeGreaterThan(11.5);
    expect(Math.max(...runs.teen.map((n) => n.inBedH))).toBeLessThanOrEqual(11 + 1e-9);
  });

  it("a healthy 7.5 h sleeper's plan is unchanged whenever their efficiency is 85 % or more (about 95 % of nights)", () => {
    const steady = runs.healthy.filter((n) => !n.floored && !n.capped);
    expect(steady.length / runs.healthy.length).toBeGreaterThanOrEqual(0.9); // 94.7 %: 2 of 40 sleep at about 84 %
    for (const n of steady) expect(n.inBedH).toBeCloseTo(n.v23InBedH, 9);
  });

  it("a healthy 22-year-old long sleeper (9.3 h) is rarely capped (a flat 10 h cap bound 81 % of nights)", () => {
    expect(runs.youngLongSleeper.filter((n) => n.capped).length / runs.youngLongSleeper.length).toBeLessThanOrEqual(0.1);
  });

  it("an older low-efficiency sleeper gets less time in bed, under the 9 h cap", () => {
    expect(mean(runs.older.map((n) => n.inBedH))).toBeLessThan(mean(runs.older.map((n) => n.v23InBedH)) - 0.5);
    expect(Math.max(...runs.older.map((n) => n.inBedH))).toBeLessThanOrEqual(9 + 1e-9);
  });

  it("time in bed never passes the age cap for anyone", () => {
    for (const r of Object.values(runs)) for (const n of r) expect(n.inBedH).toBeLessThanOrEqual(n.capH + 1e-9);
  });
});
