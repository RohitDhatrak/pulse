// The Sleep Planner on simulated sleepers (SCORING_VERSION 24; docs/algorithms/sleep-planner.md § Why version 24).
// 40 people per profile, nights 30–59 of 60, wake about 07:00, need and debt from the real personalizedNeedHours and
// ledger. Durations and efficiencies are assumptions that fit each picture. Deterministic.
import { describe, expect, it } from "vitest";
import { ledger, personalizedNeedHours } from "../scoring/sleep";
import { inBedCapHours, isWeekendDay, sleepPlan, type WakeNight } from "./sleepPlanner";

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
    // Version 42 lowered the teen floor from 9 h to 8 h, so need ÷ efficiency is now about 10.9 h (11.5+ before).
    expect(mean(runs.teen.map((n) => n.v23InBedH))).toBeGreaterThan(10.5);
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

describe("the typical wake time for shift workers and late risers (SCORING_VERSION 41, audit S6)", () => {
  // 40 people × 56 plans (nights 14–69), each plan's wake time against the morning that follows. Version 40's rule
  // (a plain median of tomorrow's kind of nights) is kept as a reference copy.
  const day = (i: number) => new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10); // a Monday first
  const plain = (xs: number[]) => {
    const t = [...xs].sort((a, b) => a - b);
    const m = t.length >> 1;
    return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2;
  };
  const v40 = (nights: WakeNight[], wakeDay: string) => {
    const r = nights.slice(-14);
    const k = r.filter((n) => isWeekendDay(n.day) === isWeekendDay(wakeDay));
    return plain((k.length ? k : r).map((n) => n.wakeMin));
  };
  function rng(seed: number) {
    let a = seed >>> 0;
    const u = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return () => Math.sqrt(-2 * Math.log(Math.max(u(), 1e-12))) * Math.cos(2 * Math.PI * u());
  }
  const clock = (a: number, b: number) => Math.min(Math.abs(a - b) % 1440, 1440 - (Math.abs(a - b) % 1440));
  function errors(wake: (i: number, g: () => number) => number) {
    const now: number[] = [];
    const before: number[] = [];
    for (let p = 0; p < 40; p++) {
      const g = rng(700 + p);
      const nights: WakeNight[] = Array.from({ length: 70 }, (_, i) => ({ day: day(i), wakeMin: ((Math.round(wake(i, g)) % 1440) + 1440) % 1440, efficiency: 0.9 }));
      for (let i = 14; i < 70; i++) {
        const plan = sleepPlan({ baselineNeedHours: 7.5, todayLoad: null, typicalSession: null, debtMin: 0, napMin: 0, nights: nights.slice(0, i), wakeDay: day(i), age: 35 });
        now.push(clock(plan.wakeMin!, nights[i].wakeMin));
        before.push(clock(v40(nights.slice(0, i), day(i)), nights[i].wakeMin));
      }
    }
    return { now, before };
  }
  const med = (xs: number[]) => plain(xs);
  const over2h = (xs: number[]) => xs.filter((e) => e > 120).length / xs.length;

  it("a weekly day/night rotation (06:40 ↔ 15:30): about 25 min off, wrong only after a switch (version 40: 265 min, always over 2 h)", () => {
    const e = errors((i, g) => (Math.floor(i / 7) % 2 ? 930 : 400) + 25 * g());
    expect(med(e.before)).toBeGreaterThan(200);
    expect(over2h(e.before)).toBeGreaterThan(0.9);
    expect(med(e.now)).toBeLessThan(30); // measured 24
    expect(over2h(e.now)).toBeLessThanOrEqual(1 / 7 + 0.01); // the first night of each week: 14.4 %
  });

  it("an evening shift waking around 00:10 and wakes alternating 23:40 / 00:20: about 20 min off (version 40: 45 and 700)", () => {
    const evening = errors((_, g) => 10 + 30 * g());
    expect(over2h(evening.before)).toBeGreaterThan(0.2);
    expect(med(evening.now)).toBeLessThan(30);
    expect(over2h(evening.now)).toBeLessThan(0.01);
    const alternating = errors((i) => (i % 2 ? 20 : 1420));
    expect(med(alternating.before)).toBeGreaterThan(600);
    expect(med(alternating.now)).toBeLessThanOrEqual(20);
  });

  it("weekday 07:00 with weekend lie-ins to 09:30, and a steady 07:00 sleeper, plan as well as before", () => {
    for (const wake of [(i: number, g: () => number) => (isWeekendDay(day(i)) ? 570 : 420) + 20 * g(), (_: number, g: () => number) => 420 + 25 * g()]) {
      const e = errors(wake);
      expect(Math.abs(med(e.now) - med(e.before))).toBeLessThanOrEqual(2);
      expect(over2h(e.now)).toBe(0);
    }
  });
});
