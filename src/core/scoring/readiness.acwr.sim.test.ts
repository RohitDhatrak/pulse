// ACWR on simulated people (SCORING_VERSION 27, 45, 46 and 47; docs/algorithms/training-load.md § Why version 27, 45, 46, 47). 30 people per
// case through the real readiness.evaluate. Daily TRIMP is log-normal: rest days around 4, walks and sessions as
// named. Deterministic.
import { describe, expect, it } from "vitest";
import { strainTargetConfig } from "../algorithms/strainTarget";
import { seenLoad } from "./load";
import { acwrChronicFloor, evaluate, lightLoadJump } from "./readiness";

let s = 7;
const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648), s / 2147483648);
const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
const ln = (m: number, cv: number) => m * Math.exp(cv * g() - (cv * cv) / 2);
const rest = () => ln(4, 0.5);
const day = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
const weekly = (n: number, days: number[], session: number) => Array.from({ length: n }, (_, i) => (days.includes(i % 7) ? ln(session, 0.25) : rest()));

type Share = { spiking: number; building: number; sweet: number; down: number; light: number };
/** Shares of days by band ("light" = no ratio) over days [from, to) of 30 people. */
function shares(gen: () => number[], from: number, to: number): Share {
  const c = { spiking: 0, building: 0, sweet: 0, down: 0, light: 0 };
  let n = 0;
  for (let p = 0; p < 30; p++) {
    const loads = gen();
    for (let t = from; t < to; t++) {
      n++;
      const r = evaluate(loads.slice(0, t + 1).map((load, i) => ({ day: day(i), load })));
      const detail = r.signals.find((x) => x.key === "acwr")?.detail;
      if (r.lightLoad) c.light++;
      else if (detail === "LOAD_SPIKING") c.spiking++;
      else if (detail === "LOAD_BUILDING_FAST") c.building++;
      else if (detail === "LOAD_SWEET_SPOT") c.sweet++;
      else if (detail === "LOAD_RAMPING_DOWN") c.down++;
    }
  }
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v / n])) as Share;
}

describe("sedentary and light days get no ratio (version 26: spiking after a walk)", () => {
  it("weeks of rest and one 40-TRIMP walk: light, for everyone (version 26: 30 of 30 spiking)", () => {
    expect(shares(() => [...Array.from({ length: 56 }, () => ln(3, 0.4)), 40], 56, 57).light).toBe(1);
  });

  it.each([
    ["steady sedentary days (an occasional 15-TRIMP walk)", () => Array.from({ length: 140 }, () => (rnd() < 0.15 ? ln(15, 0.3) : rest()))],
    ["an older adult's daily walk (about 25)", () => Array.from({ length: 140 }, () => (rnd() < 0.7 ? ln(25, 0.4) : rest()))],
    ["a light trainer, 2 × 50 a week", () => weekly(140, [1, 4], 50)],
  ] as const)("%s: never building fast or spiking", (_, gen) => {
    const r = shares(gen, 40, 140);
    expect(r.building + r.spiking).toBe(0);
  });

  it("a sedentary person who starts walking 40 a day: a real 10× jump reads building fast at most, rarely spiking", () => {
    const r = shares(() => [...Array.from({ length: 56 }, rest), ...Array.from({ length: 28 }, () => ln(40, 0.3))], 56, 70);
    expect(r.spiking).toBeLessThanOrEqual(0.15); // version 26: 99 %
  });
});

describe("real spikes are still caught, and trained people are unchanged", () => {
  it("a sedentary person who starts running 5 days a week reads spiking", () => {
    expect(shares(() => [...Array.from({ length: 56 }, rest), ...weekly(28, [0, 1, 2, 3, 4], 120)], 60, 70).spiking).toBeGreaterThanOrEqual(0.95);
  });

  it.each([
    ["light 2 × 50 → 5 × 100", () => [...weekly(84, [1, 4], 50), ...weekly(14, [0, 1, 2, 3, 4], 100)]],
    ["regular 3 × 100 → 6 × 150", () => [...weekly(84, [0, 2, 4], 100), ...weekly(14, [0, 1, 2, 3, 4, 5], 150)]],
  ] as const)("%s: spiking at least 80 % of the next 10 days", (_, gen) => {
    expect(shares(gen, 88, 98).spiking).toBeGreaterThanOrEqual(0.8);
  });

  it.each([
    ["moderate 3 × 80 (chronic about 36)", () => weekly(140, [0, 2, 4], 80)],
    ["regular 4 × 118", () => weekly(140, [0, 2, 4, 5], 118)],
  ] as const)("%s: almost never light, mostly in the sweet spot", (_, gen) => {
    const r = shares(gen, 40, 140);
    expect(r.light).toBeLessThanOrEqual(0.01);
    expect(r.sweet).toBeGreaterThanOrEqual(0.9);
  });
});

describe("session timing no longer drives the bands (version 45: EWMA acute ÷ chronic)", () => {
  // Its own draws, all made up front, so the cases above don't shift them. Version 44 and 45 see the same people.
  s = 7;
  /** A week's session days: `k` distinct random weekdays. */
  const randomDays = (k: number) => {
    const a = [0, 1, 2, 3, 4, 5, 6];
    for (let i = 6; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, k);
  };
  /** `n` days of weeks: `perWeek()` sessions on random days (or `fixed` days) of `session(week)` TRIMP, rest otherwise. */
  const schedule = (n: number, perWeek: () => number, session: (w: number) => number, fixed?: number[]) => {
    const out: number[] = [];
    for (let w = 0; out.length < n; w++) {
      const days = fixed ?? randomDays(perWeek());
      for (let i = 0; i < 7 && out.length < n; i++) out.push(days.includes(i) ? ln(session(w), 0.25) : rest());
    }
    return out;
  };
  type Ratio = (loads: number[]) => number | null;
  /** Version 44: the mean of the last 7 calendar days over the last 28, with version 27's floor. */
  const v44: Ratio = (loads) => {
    const a = loads.slice(-7), c = loads.slice(-28);
    if (c.length < 14 || a.length < 4) return null;
    const am = a.reduce((x, y) => x + y, 0) / a.length, cm = c.reduce((x, y) => x + y, 0) / c.length;
    if (cm >= acwrChronicFloor) return am / cm;
    return am / acwrChronicFloor >= lightLoadJump ? am / acwrChronicFloor : null;
  };
  const v45: Ratio = (loads) => evaluate(loads.map((load, i) => ({ day: day(i), load }))).acwr;
  const people = (gen: () => number[]) => Array.from({ length: 30 }, gen);

  /**
   * Shares of days 42+ building fast, spiking, ramping down, and capped: Strain Target caps when yesterday's ratio is
   * over `acwrCapAbove`, ahead of every other hold (strainTarget.ts), so this is its cap rate on days with a target.
   */
  function noise(ratio: Ratio, ps: number[][]) {
    let n = 0, building = 0, spiking = 0, down = 0, capped = 0;
    for (const loads of ps) {
      let prev: number | null = null;
      for (let t = 42; t < loads.length; t++) {
        const r = ratio(loads.slice(0, t + 1));
        n++;
        if (r != null && r >= 1.5) spiking++;
        else if (r != null && r >= 1.3) building++;
        else if (r != null && r < 0.8) down++;
        if (prev != null && prev > strainTargetConfig.acwrCapAbove) capped++;
        prev = r;
      }
    }
    return { building: building / n, spiking: spiking / n, down: down / n, capped: capped / n };
  }
  /** Share of people whose ratio reaches `at` within `within` days of day `start`. */
  function caught(ratio: Ratio, ps: number[][], start: number, at: number, within: number) {
    return ps.filter((loads) => Array.from({ length: within }, (_, k) => ratio(loads.slice(0, start + k + 1))).some((r) => r != null && r >= at)).length / ps.length;
  }

  const fixed3 = people(() => schedule(154, () => 3, () => 80, [1, 3, 5]));
  const random3 = people(() => schedule(154, () => 3, () => 80));
  const varying = people(() => schedule(154, () => 1 + Math.floor(rnd() * 5), () => 80));
  const stepUp = people(() => schedule(126, () => 3, (w) => (w < 14 ? 80 : 120)));
  const doubling = people(() => schedule(126, () => 3, (w) => (w < 14 ? 80 : 160)));
  const resumed = people(() => [...schedule(84, () => 3, () => 80), ...Array.from({ length: 10 }, rest), ...schedule(28, () => 3, () => 80)]);

  it("3 sessions a week on random days: capped 11 % → under 3 %, spiking 2 % → none", () => {
    const old = noise(v44, random3), now = noise(v45, random3);
    expect(old.capped).toBeGreaterThan(0.1);
    expect(old.spiking).toBeGreaterThan(0.02);
    expect(now.capped).toBeLessThan(0.03);
    expect(now.building + now.spiking).toBeLessThan(0.03);
    expect(now.spiking).toBe(0);
    expect(now.down).toBeLessThan(old.down / 2);
  });

  it("1–5 sessions a week: spiking (\"strained\") 8 % → about 2 %, capped 18 % → about 12 %", () => {
    const old = noise(v44, varying), now = noise(v45, varying);
    expect(old.spiking).toBeGreaterThan(0.07);
    expect(now.spiking).toBeLessThan(0.03);
    expect(now.capped).toBeLessThan(old.capped * 0.7);
  });

  it("3 sessions a week on fixed days: no worse (about 2 % before, under 1 % now)", () => {
    const old = noise(v44, fixed3), now = noise(v45, fixed3);
    expect(now.building + now.spiking).toBeLessThanOrEqual(old.building + old.spiking);
    expect(now.capped).toBeLessThan(0.01);
  });

  it("a real step up is still caught: +50 % from week 15 builds fast within a week for at least as many people (87 %, was 83 %)", () => {
    const ps = stepUp;
    expect(caught(v45, ps, 98, 1.3, 7)).toBeGreaterThanOrEqual(caught(v44, ps, 98, 1.3, 7));
    expect(caught(v45, ps, 98, 1.3, 7)).toBeGreaterThanOrEqual(0.8);
  });

  it("a doubling is caught: building fast within a week for nearly everyone, spiking within 10 days for most", () => {
    const ps = doubling;
    expect(caught(v45, ps, 98, 1.3, 7)).toBeGreaterThanOrEqual(0.9);
    expect(caught(v45, ps, 98, 1.5, 10)).toBeGreaterThanOrEqual(0.75);
  });

  it("training resumed after 10 rest days (audit T6): spiking on about 12 % of the next 4 weeks → under 1 %", () => {
    const ps = resumed;
    const share = (ratio: Ratio) => {
      let n = 0, bad = 0;
      for (const loads of ps) {
        for (let t = 94; t < 122; t++) {
          n++;
          if ((ratio(loads.slice(0, t + 1)) ?? 0) >= 1.5) bad++;
        }
      }
      return bad / n;
    };
    expect(share(v44)).toBeGreaterThan(0.08);
    expect(share(v45)).toBeLessThan(0.01);
  });
});

describe("complete, seen days (version 46)", () => {
  s = 11;
  const randomDays = (k: number) => {
    const a = [0, 1, 2, 3, 4, 5, 6];
    for (let i = 6; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, k);
  };
  type Day = { load: number; session: boolean };
  /** A steady trainer: 3 sessions of about 80 TRIMP a week on random days, rest days about 4. */
  const trainer = (n = 154): Day[] => {
    const out: Day[] = [];
    while (out.length < n) {
      const days = randomDays(3);
      for (let i = 0; i < 7 && out.length < n; i++) out.push(days.includes(i) ? { load: ln(80, 0.25), session: true } : { load: rest(), session: false });
    }
    return out;
  };
  /**
   * What the band saw: the day's TRIMP and its heart-rate minutes outside sleep. "sleep20": 1 day in 5 worn only in bed
   * (10–40 minutes on after waking); half of those days' workouts were done with the band on. "short": 2–6 h of
   * daytime wear that includes the workout.
   */
  const wear = (kind: "allDay" | "sleep20" | "short", ds: Day[]) =>
    ds.map((d) => {
      if (kind === "short") {
        const h = 2 + 4 * rnd();
        return { trimp: d.session ? d.load : (d.load * h) / 16, awake: h * 60 };
      }
      if (kind === "allDay" || rnd() >= 0.2) return { trimp: d.load, awake: 840 + 120 * rnd() };
      const incidental = 10 + 30 * rnd();
      if (d.session && rnd() < 0.5) return { trimp: d.load, awake: incidental + 60 + 30 * rnd() };
      return { trimp: rnd() < 0.5 ? 0 : ln(1.5, 0.5), awake: incidental };
    });
  const rows = (loads: (number | null)[]) => loads.map((load, i) => ({ day: day(i), load }));
  const through = (loads: (number | null)[], t: number) => evaluate(rows(loads.slice(0, t + 1)), null, undefined, "yesterday").acwr;
  const band = (r: number | null) => (r == null ? "none" : r >= 1.5 ? "spiking" : r >= 1.3 ? "building" : r < 0.8 ? "down" : "sweet");
  const people = Array.from({ length: 30 }, () => trainer());
  const seen = { allDay: people.map((p) => wear("allDay", p)), sleep20: people.map((p) => wear("sleep20", p)), short: people.map((p) => wear("short", p)) };

  /** Shares of days 42+ where the band read differs from the fully seen person's: false high, false ramping down, no ratio. */
  function errors(obs: { trimp: number; awake: number }[][], rule: (o: { trimp: number; awake: number }) => number | null) {
    let n = 0, high = 0, down = 0, none = 0;
    people.forEach((p, k) => {
      const truth = p.map((d) => d.load);
      const loads = obs[k].map(rule);
      for (let t = 42; t < p.length; t++) {
        n++;
        const b = band(through(loads, t)), tb = band(through(truth, t));
        if ((b === "building" || b === "spiking") && tb !== "building" && tb !== "spiking") high++;
        if (b === "down" && tb !== "down") down++;
        if (b === "none") none++;
      }
    });
    return { high: high / n, down: down / n, none: none / n };
  }
  /** Version 45: any heart rate makes a measured day (a sleep-only day is 0). */
  const v45 = (o: { trimp: number }) => o.trimp;
  const v46 = (o: { trimp: number; awake: number }) => seenLoad(o.trimp, true, o.awake);

  it("T5: the band no longer changes between morning and evening on a training day (version 45: 37–49 % of them)", () => {
    let n = 0, differs = 0, differed = 0;
    for (const p of people) {
      const loads = p.map((d) => d.load);
      for (let t = 42; t < p.length; t++) {
        if (!p[t].session) continue;
        n++;
        const morning = [...loads.slice(0, t), 0];
        const evening = loads.slice(0, t + 1);
        if (band(through(morning, t)) !== band(through(evening, t))) differs++;
        const today = (ls: number[]) => evaluate(rows(ls)).acwr;
        if (band(today(morning)) !== band(today(evening))) differed++;
      }
    }
    expect(differs).toBe(0);
    expect(differed / n).toBeGreaterThan(0.3);
  });

  it("T4: 1 day in 5 worn only in bed: no ratio 13 % → 1.4 % of days, false building fast or spiking 2.9 → 2.1 %", () => {
    const old = errors(seen.sleep20, v45), now = errors(seen.sleep20, v46);
    // Zeros for unseen days pulled chronic under the 30 floor, so the ratio went missing ("light load").
    expect(old.none).toBeGreaterThan(0.12);
    expect(now.none).toBeLessThan(0.03);
    expect(now.high).toBeLessThan(old.high);
    // The cost: false ramping down rises by at most a point (4.9 → 5.1 %), since an unseen workout is lost either way.
    expect(now.down).toBeLessThanOrEqual(old.down + 0.01);
  });

  it("T4: people who wear it all day, or 2–6 h with the workout, read exactly as before", () => {
    for (const kind of ["allDay", "short"] as const) expect(errors(seen[kind], v46)).toEqual(errors(seen[kind], v45));
  });
});

describe("monotony is information only (version 47)", () => {
  s = 13;
  // 30 people per schedule, 154 days, read through yesterday from day 42. HRV and RHR vary night to night around the
  // person's own level and don't depend on load, so every schedule should be primed about equally often.
  const schedules = {
    daily: () => Array.from({ length: 154 }, () => ln(150, 0.2)),
    sixAWeek: () => Array.from({ length: 154 }, (_, i) => (i % 7 === 6 ? rest() : ln(150, 0.2))),
    threeAWeek: () => weekly(154, [0, 2, 4], 150),
  };
  type Level = { primed: number; balanced: number; strainedOrWorse: number; monotonyHigh: number; v46Primed: number };
  const levels = Object.fromEntries(
    Object.entries(schedules).map(([name, gen]) => {
      const c = { primed: 0, balanced: 0, strainedOrWorse: 0, monotonyHigh: 0, v46Primed: 0 };
      let n = 0;
      for (let p = 0; p < 30; p++) {
        const loads = gen();
        const rows = loads.map((load, i) => ({ day: day(i), load, hrv: ln(60, 0.15), rhr: 52 + 2.5 * g(), resp: 14 }));
        for (let t = 42; t < 154; t++) {
          n++;
          const r = evaluate(rows.slice(0, t + 1), null, undefined, "yesterday");
          const high = r.monotony != null && r.monotony >= 2;
          if (high) c.monotonyHigh++;
          if (r.level === "primed") c.primed++;
          else if (r.level === "balanced") c.balanced++;
          else if (r.level === "strained" || r.level === "rundown") c.strainedOrWorse++;
          // Version 46 added a "watch" at monotony ≥ 2, which turned exactly these primed days into balanced.
          if (r.level === "primed" && !high) c.v46Primed++;
        }
      }
      return [name, Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v / n])) as Level];
    }),
  ) as Record<keyof typeof schedules, Level>;

  it("daily and 6-a-week trainers are primed as often as a 3-a-week one (version 46: 0 % and 6 %)", () => {
    // Measured: primed 33.0 / 33.0 / 33.0 %; version 46 read 0 / 6.4 / 33.0 %.
    expect(levels.daily.monotonyHigh).toBe(1);
    expect(levels.daily.v46Primed).toBe(0);
    expect(levels.sixAWeek.monotonyHigh).toBeGreaterThan(0.7);
    expect(levels.sixAWeek.v46Primed).toBeLessThan(0.1);
    expect(levels.threeAWeek.monotonyHigh).toBe(0);
    for (const l of [levels.daily, levels.sixAWeek]) {
      expect(Math.abs(l.primed - levels.threeAWeek.primed)).toBeLessThan(0.03);
      expect(l.primed).toBeGreaterThan(l.v46Primed + 0.25);
    }
  });

  it("strained and run down don't depend on the schedule: monotony was only ever a watch", () => {
    for (const l of [levels.daily, levels.sixAWeek]) expect(Math.abs(l.strainedOrWorse - levels.threeAWeek.strainedOrWorse)).toBeLessThan(0.03);
  });
});
