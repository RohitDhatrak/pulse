// Sleep need and debt on simulated sleepers (SCORING_VERSION 40, audit S4; docs/algorithms/sleep-need.md § Why version
// 40). Each day as the pipeline runs it: this morning's need is last evening's (held) need, the ledger replays the last
// 14 nights against it, then tonight's need is set from the nights so far. Version 39 (the plain median and the 0.55
// ledger) is kept below as a reference copy. 200 people per case, each with their own usual length (±0.2 h) and
// Gaussian night-to-night variation. Deterministic.
import { describe, expect, it } from "vitest";
import { sleepPlan } from "../algorithms/sleepPlanner";
import { heldNeedHours, ledger, personalizedNeedHours } from "./sleep";

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

/** Version 39: debt = 0.55 × max(0, need + debt − slept) over the last 14 nights, clearing under 10. */
function ledgerV39(sleptMin: number[], needHours: number): number {
  let d = 0;
  for (const s of sleptMin.slice(-14)) {
    const c = 0.55 * Math.max(needHours * 60 + d - s, 0);
    d = c < 10 ? 0 : c;
  }
  return d;
}

type Day = { need: number; debt: number };
/** Each day's morning need and debt, for nightly hours `hours`. */
function days(hours: number[], v39 = false): Day[] {
  const nights: number[] = [];
  const series: [string, number][] = [];
  let held: number | null = null;
  return hours.map((h, i) => {
    const morning = v39 ? personalizedNeedHours(nights.slice(-28), 35) : (held ?? personalizedNeedHours(nights.slice(-28), 35));
    nights.push(h);
    series.push([String(i), h * 60]);
    const debt = v39 ? ledgerV39(series.map(([, m]) => m), morning) : ledger(series, morning).magnitudeMin;
    // Only a learned need is held: before 7 nights it is the 7.5 h default, not yours (as scorePlanner does).
    held = heldNeedHours(personalizedNeedHours(nights.slice(-28), 35), nights.length - 1 >= 7 ? held : null);
    return { need: morning, debt };
  });
}
const people = (mu: number, sd: number, n: number, mod: (i: number, h: number) => number = (_, h) => h, seed = 1) =>
  Array.from({ length: 200 }, (_, k) => {
    const g = rng(seed * 1000 + k);
    const m = mu + 0.2 * g();
    return Array.from({ length: n }, (_, i) => mod(i, Math.max(3, m + sd * g())));
  });
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const share = (xs: number[]) => xs.filter((x) => x >= 10).length / xs.length;

describe("ordinary sleepers: no more debt days than before", () => {
  // Days 40 on. v39 / v40, share of days with 10+ min of debt and mean debt: 7 ± 0.5 h 49 % 13 / 44 % 21;
  // 7.5 ± 0.5 38 % 9 / 35 % 15; 8 ± 0.5 38 % 9 / 35 % 15; 7.5 ± 0.3 22 % 4 / 11 % 3.
  it.each([
    [7.5, 0.5],
    [8, 0.5],
    [7.5, 0.3],
  ])("%f ± %f h: debt on no more days than version 39, and at most 20 min on average", (mu, sd) => {
    const now = people(mu, sd, 120).flatMap((h) => days(h).slice(40).map((x) => x.debt));
    const before = people(mu, sd, 120).flatMap((h) => days(h, true).slice(40).map((x) => x.debt));
    expect(share(now)).toBeLessThanOrEqual(share(before) + 0.01);
    expect(mean(now)).toBeLessThanOrEqual(20);
  });

  it("7 ± 0.5 h (at the adult floor, so half their nights fall below it): at most 25 min on average", () => {
    expect(mean(people(7, 0.5, 120).flatMap((h) => days(h).slice(40).map((x) => x.debt)))).toBeLessThanOrEqual(25);
  });
});

describe("chronic restriction stays visible (audit S4)", () => {
  // An 8 h sleeper (±0.4 h) cut to 7 h from night 60.
  const cut = people(8, 0.4, 150, (i, h) => (i >= 60 ? h - 1 : h));
  const week = (rs: Day[][], w: number, k: keyof Day) => mean(rs.map((r) => r[60 + 7 * w - 1][k]));
  const now = cut.map((h) => days(h));
  const before = cut.map((h) => days(h, true));

  it("debt in weeks 3 and 8 at least an hour (version 39: 16 and 10 min)", () => {
    expect(week(before, 3, "debt")).toBeLessThan(25);
    expect(week(before, 8, "debt")).toBeLessThan(25);
    expect(week(now, 3, "debt")).toBeGreaterThanOrEqual(90); // measured 118
    expect(week(now, 8, "debt")).toBeGreaterThanOrEqual(60); // measured 70
  });

  it("the need in week 8 is still at least 7.5 h (version 39: 7.1)", () => {
    expect(week(before, 8, "need")).toBeLessThan(7.2);
    expect(week(now, 8, "need")).toBeGreaterThanOrEqual(7.5);
  });

  it("a 7.5 h sleeper cut to 6.5 h still reads over an hour in week 8 (version 39: 37 min)", () => {
    const r = people(7.5, 0.4, 150, (i, h) => (i >= 60 ? h - 1 : h)).map((h) => days(h));
    expect(week(r, 8, "debt")).toBeGreaterThanOrEqual(60);
  });

  it("the Sleep Planner's time in bed stays inside its age cap throughout", () => {
    const nights = Array.from({ length: 14 }, (_, k) => ({ day: `2026-06-${String(k + 1).padStart(2, "0")}`, wakeMin: 420, efficiency: 0.88 }));
    for (const r of now.slice(0, 40)) {
      for (const d of r.slice(60)) {
        const plan = sleepPlan({ baselineNeedHours: d.need, todayLoad: null, typicalSession: null, debtMin: d.debt, napMin: 0, nights, wakeDay: "2026-06-15", age: 35 });
        for (const p of plan.plans) expect(p.inBedMin).toBeLessThanOrEqual(plan.inBedCapMin + 1e-9);
      }
    }
  });
});

describe("what must still be forgiven", () => {
  it("a genuine lasting half-hour change fades to under 20 min by week 12", () => {
    const r = people(8, 0.4, 160, (i, h) => (i >= 60 ? h - 0.5 : h)).map((h) => days(h));
    expect(mean(r.map((x) => x[60 + 83].debt))).toBeLessThan(20); // measured about 10
  });

  it("5 sick nights of 9.5 h raise the need by under 10 min a week later, and under 5 a month later", () => {
    const sick = people(7.5, 0.3, 120, (i, h) => (i >= 60 && i < 65 ? 9.5 : h), 7).map((h) => days(h));
    const base = people(7.5, 0.3, 120, (_, h) => h, 7).map((h) => days(h));
    const lift = (day: number) => mean(sick.map((r, k) => r[day].need - base[k][day].need)) * 60;
    expect(lift(70)).toBeLessThan(10); // measured 4.7
    expect(lift(95)).toBeLessThan(5); // measured 2.4 (version 39: 0)
  });

  it("one all-nighter clears within about 10 nights", () => {
    const r = people(7.5, 0.3, 100, (i, h) => (i === 60 ? 0 : h), 9).map((h) => days(h));
    const clears = mean(r.map((x) => {
      let k = 60;
      while (k < 99 && x[k].debt >= 10) k++;
      return k - 60;
    }));
    expect(clears).toBeLessThanOrEqual(10); // measured about 7 (version 39: 6)
  });
});

// SCORING_VERSION 42 (audit S7; docs/algorithms/sleep-need.md § Why version 42): the age floor. Version 41 is kept as a
// reference: 9 h under 18 by whole years, 7 h after, and a new floor restarted the held need. personalizedNeedHours at
// an adult age is clamp(median, 7, 9.5), so raising it to a floor F in 7–9 gives clamp(median, F, 9.5).
const floorV41 = (years: number) => (Math.floor(years) < 18 ? 9 : 7);
/** Each day's morning need and debt for a person aged `ageAt(i)` on day i, as scorePlanner runs. */
function agedDays(hours: number[], ageAt: (i: number) => number, v41 = false): Day[] {
  const nights: number[] = [];
  const series: [string, number][] = [];
  let held: number | null = null;
  let heldFloor: number | null = null;
  const raw = (age: number) => {
    const r = personalizedNeedHours(nights.slice(-28), v41 ? 30 : age);
    return v41 ? Math.max(r, floorV41(age)) : r;
  };
  return hours.map((h, i) => {
    const morning = held ?? raw(ageAt(i));
    nights.push(h);
    series.push([String(i), h * 60]);
    const debt = ledger(series, morning).magnitudeMin;
    const floor = v41 ? floorV41(ageAt(i)) : null;
    const learned = nights.length - 1 >= 7 && (!v41 || heldFloor === floor);
    held = heldNeedHours(raw(ageAt(i)), learned ? held : null);
    heldFloor = floor;
    return { need: morning, debt };
  });
}

describe("version 42 (audit S7): the teen floor is the guideline's lower bound, and slides by age", () => {
  it("16-year-olds sleeping 8.5 h (inside the 8–10 h guideline) carry under 10 min of debt (version 41: 63)", () => {
    const sixteen = people(8.5, 0.4, 120, undefined, 21);
    const now = sixteen.flatMap((h) => agedDays(h, () => 16).slice(40).map((x) => x.debt));
    const before = sixteen.flatMap((h) => agedDays(h, () => 16, true).slice(40).map((x) => x.debt));
    expect(mean(before)).toBeGreaterThan(40); // measured 63, on 85 % of days
    expect(mean(now)).toBeLessThanOrEqual(10); // measured 8.8, on 25 %
  });

  it("a 7.5 h teen, under the 8 h floor, still shows debt", () => {
    const r = people(7.5, 0.4, 120, undefined, 22).flatMap((h) => agedDays(h, () => 16).slice(40).map((x) => x.debt));
    expect(mean(r)).toBeGreaterThanOrEqual(20); // measured 62 (version 41: 225)
  });

  it("turning 18 moves nothing overnight (version 41: debt fell from about 143 to 10 min the morning after)", () => {
    // 8 h sleepers, 17.75 years old on day 0: day 92 is the first at 18, so day 93's morning need is the first set at 7 h.
    const ageAt = (i: number) => 17.75 + i / 365.25;
    const birthday = 93;
    const sleepers = people(8, 0.4, 180, undefined, 23);
    const now = sleepers.map((h) => agedDays(h, ageAt));
    const before = sleepers.map((h) => agedDays(h, ageAt, true));
    const avg = (rs: Day[][], i: number, k: keyof Day) => mean(rs.map((r) => r[i][k]));
    const jump = (rs: Day[][], k: keyof Day) => Math.max(...Array.from({ length: 120 }, (_, j) => Math.abs(avg(rs, 41 + j + 1, k) - avg(rs, 41 + j, k))));
    expect(avg(before, birthday - 1, "debt") - avg(before, birthday, "debt")).toBeGreaterThan(100); // measured 143 → 10
    expect(avg(before, birthday - 1, "need") - avg(before, birthday, "need")).toBeGreaterThan(0.9);
    expect(jump(now, "debt")).toBeLessThanOrEqual(10); // measured 4.0
    expect(jump(now, "need") * 60).toBeLessThanOrEqual(1); // measured 0.2 min
  });
});
