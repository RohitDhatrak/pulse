// Stress and the Energy Bank on generated days (SCORING_VERSION 21, 50 and 52; docs/algorithms/stress.md § Why version 21, 50, 52).
// People are warmed up over 7 weeks of realistic mixed days, then scored on one scenario at a time, as the pipeline
// scores them (stage 1 masking with exertion, stage 2 against the gated baseline). Deterministic.
import { describe, expect, it } from "vitest";
import { earlyCleanConfig, foldableStillMedian, foldDaytimeBaseline, stillGateConfig } from "../scoring/stressBase";
import { caught, caughtOfAll, foldStill, highAroundBouts, highMinutes, people, rng, scoreDay, warmUp, weekMix, type Scenario, type ScoredDay, type StillFold } from "./__sim__/days";

const PE = people();
// A cross-section: typical, athlete, older adult, high-reactor, noisy wrist HR, standing job, heavy coffee.
const CROSS = [0, 1, 2, 3, 5, 7, 11];
const warm = new Map<number, ReturnType<typeof warmUp>>();
const warmFor = (pi: number) => {
  if (!warm.has(pi)) warm.set(pi, warmUp(PE[pi], 900 + pi));
  return warm.get(pi)!;
};
const days = (s: Scenario, persons = CROSS, reps = 4): ScoredDay[] =>
  persons.flatMap((pi) => {
    const w = warmFor(pi);
    return Array.from({ length: reps }, (_, k) => scoreDay(PE[pi], s, w.nextDay + k, w.history, rng(pi * 100 + k + 7)));
  });
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
const medHigh = (s: Scenario) => median(days(s).map(highMinutes));

describe("false stress on days with no psychological stress", () => {
  // Version 20 (the same generator): calm 58, coffee 306, hot 182, illness 763, hangover 610, unlogged ride 119,
  // the tail after a logged run 74.
  it.each([
    ["calm_desk", 70],
    ["coffee_heavy", 160],
    ["hot_day", 160],
    ["illness", 200],
    ["hangover", 200],
    ["unlogged_cycling", 75],
    ["logged_run", 65],
  ] as const)("%s: at most %i high minutes (median)", (s, max) => {
    expect(medHigh(s)).toBeLessThanOrEqual(max);
  });
});

describe("real stress is still caught", () => {
  it("stressful workdays: at least 68 % of stress minutes read high (version 20: 79 %)", () => {
    expect(caught(days("stressful_work", [0, 1, 3, 5, 6, 7, 8, 9, 10, 11]))).toBeGreaterThanOrEqual(0.68);
  });

  it("a 2.5-hour episode is not absorbed as 'the day's level': at least 75 % read high", () => {
    expect(caught(days("long_stress", [0, 1, 3, 5, 6, 7, 8, 9, 10, 11]))).toBeGreaterThanOrEqual(0.75);
  });

  it("an older adult (smaller stress response, lower max HR): at least 55 %", () => {
    expect(caught(days("stressful_work", [2], 8))).toBeGreaterThanOrEqual(0.55);
  });
});

describe("the cool-down after light movement (version 36)", () => {
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  it("a late morning of housework or errands: high minutes during it and the 45 after, mean at most 10 (version 35: 19.2)", () => {
    const d = days("light_activity", CROSS, 6);
    expect(mean(d.map((x) => highAroundBouts(x)))).toBeLessThanOrEqual(10);
    expect(median(d.map((x) => highAroundBouts(x)))).toBeLessThanOrEqual(8); // version 35: 18
  });

  it("stress right after a 20-minute walk: at least 37 % of it reads high, counting blocked minutes as missed", () => {
    // The cost of the tail's first 10 minutes: version 35 caught 53 %, this rule 40 %, a 15-minute check 35 %.
    expect(caughtOfAll(days("stress_after_walk", [0, 1, 3, 5, 6, 7, 8, 9, 10, 11]))).toBeGreaterThanOrEqual(0.37);
  });
});

describe("the Energy Bank reads the corrected stress", () => {
  const ends = (s: Scenario) => median(days(s).map((x) => x.eb.current));

  it("a heavy-coffee day no longer empties it (version 20: median 13)", () => {
    expect(ends("coffee_heavy")).toBeGreaterThanOrEqual(20);
  });

  it("a calm desk day still ends inside the 15–40 target, near 30", () => {
    const e = ends("calm_desk");
    expect(e).toBeGreaterThanOrEqual(25);
    expect(e).toBeLessThanOrEqual(35);
  });

  it("an illness day reaches 0 in the evening, not at lunchtime (version 20: about 13:30)", () => {
    const firstZero = days("illness").map((x) => {
      const i = x.eb.curve.findIndex((v) => v != null && v <= 0.001);
      return i < 0 ? 24 : i / 60;
    });
    expect(median(firstZero)).toBeGreaterThanOrEqual(18);
  });
});

describe("the daytime baseline after an illness week", () => {
  it("an athlete's stress detection the week after illness drops by at most 3 points (version 20: 78 → 70 %)", () => {
    const P = PE[1];
    const w = warmUp(P, 601);
    const before = scoreDay(P, "stressful_work", w.nextDay + 20, w.history, rng(6));
    const h = [...w.history];
    let day = w.nextDay;
    const r = rng(12);
    // Fold as the pipeline does, through the gate.
    for (let k = 0; k < 5; k++) {
      const x = scoreDay(P, "illness", day++, h, r);
      h.push(foldableStillMedian(h, x.stress.stillMedianHr));
    }
    const after = scoreDay(P, "stressful_work", day, h, rng(6));
    expect(caught([after])).toBeGreaterThanOrEqual(caught([before]) - 0.03);
  });

  it("weeks of sustained stress still fold and are still caught in week 3 (at least 65 %)", () => {
    const rates: number[] = [];
    for (const pi of [0, 2, 3, 9]) {
      const P = PE[pi];
      const w = warmUp(P, 600 + pi);
      const h = [...w.history];
      let day = w.nextDay + 50;
      const r = rng(5 + pi);
      const week3: ScoredDay[] = [];
      for (let wk = 0; wk < 3; wk++) {
        for (let k = 0; k < 7; k++) {
          const s: Scenario = k < 5 ? "stressful_work" : "rest_day";
          const x = scoreDay(P, s, day++, h, r);
          if (wk === 2 && s === "stressful_work") week3.push(x);
          h.push(foldableStillMedian(h, x.stress.stillMedianHr));
        }
      }
      rates.push(caught(week3));
    }
    expect(rates.reduce((a, b) => a + b, 0) / rates.length).toBeGreaterThanOrEqual(0.65);
  });
});

describe("a lasting rise in daytime HR becomes the new normal (version 50)", () => {
  // Every person, warmed up as usual, then weeks of ordinary mixed days with awake still HR raised by `rise` bpm (a
  // medicine stopped, heat, altitude, detraining). `release` Infinity is version 49: the gate alone.
  function weeks(rise: number, n: number, release = stillGateConfig.release) {
    const keep = stillGateConfig.release;
    stillGateConfig.release = release;
    try {
      const perWeek: number[][] = Array.from({ length: n }, () => []);
      let releases = 0;
      const errors: number[] = [];
      PE.forEach((P0, pi) => {
        const w = warmFor(pi);
        const st: StillFold = { history: [...w.history], gate: w.gate };
        const before = foldDaytimeBaseline(st.history).baseline;
        const P = { ...P0, stillOffset: P0.stillOffset + rise };
        const r = rng(5000 + pi);
        let day = w.nextDay;
        for (let k = 0; k < n; k++) {
          let high = 0;
          for (const s of weekMix(r)) {
            const x = scoreDay(P, s, day++, st.history, r);
            if (foldStill(st, x)) releases++;
            if (s === "calm_desk" || s === "rest_day") high += highMinutes(x);
          }
          perWeek[k].push(high);
        }
        errors.push(foldDaytimeBaseline(st.history).baseline - before - rise);
      });
      return { weekly: perWeek.map(median), releases, error: median(errors) };
    } finally {
      stillGateConfig.release = keep;
    }
  }
  const control = weeks(0, 8);

  it("ordinary weeks never release (the gate behaves as in version 49)", () => {
    expect(control.releases).toBe(0);
    expect(control.weekly).toEqual(weeks(0, 8, Infinity).weekly);
  });

  it("+15 bpm: calm and rest days are back to the usual high minutes by week 3 (version 49: still about 3× in week 8)", () => {
    const now = weeks(15, 8);
    const before = weeks(15, 8, Infinity);
    expect(now.releases).toBeGreaterThanOrEqual(PE.length * 0.8);
    for (let k = 2; k < 8; k++) expect(now.weekly[k], `week ${k + 1}`).toBeLessThanOrEqual(1.5 * Math.max(...control.weekly));
    expect(before.weekly[7]).toBeGreaterThan(2 * Math.max(...control.weekly));
    expect(Math.abs(now.error)).toBeLessThan(1.5);
    expect(before.error).toBeLessThan(-6);
  });

  it("+10 bpm: settled sooner than version 49", () => {
    const now = weeks(10, 6);
    const before = weeks(10, 6, Infinity);
    expect(now.weekly[3]).toBeLessThan(before.weekly[3]);
    expect(now.weekly.slice(3).reduce((a, b) => a + b, 0)).toBeLessThan(before.weekly.slice(3).reduce((a, b) => a + b, 0));
  });

  it("an illness held from its second night stays out however long it lasts (14 days: the baseline doesn't move)", () => {
    for (const pi of [0, 1, 3]) {
      const w = warmFor(pi);
      const st: StillFold = { history: [...w.history], gate: w.gate };
      const before = foldDaytimeBaseline(st.history).baseline;
      const r = rng(70 + pi);
      for (let d = 0; d < 14; d++) foldStill(st, scoreDay(PE[pi], "illness", w.nextDay + d, st.history, r), d >= 1);
      expect(foldDaytimeBaseline(st.history).baseline, PE[pi].name).toBeCloseTo(before, 6);
    }
  });
});

describe("a new user whose first days are atypical (version 52)", () => {
  // 12 people × 3 runs from their first day: the atypical start, then stressful and calm workdays alternating.
  const RUNS = PE.flatMap((P, pi) => [0, 1, 2].map((k) => ({ P, seed: 3000 + pi * 10 + k })));
  function start(first: Scenario[], cleanDays = earlyCleanConfig.days, mix = false) {
    const keep = earlyCleanConfig.days;
    earlyCleanConfig.days = cleanDays;
    try {
      const byDay = Array.from({ length: 35 }, () => ({ xs: [] as ScoredDay[], ref: [] as number[] }));
      for (const { P, seed } of RUNS) {
        const st: StillFold = { history: [], gate: { run: [] } };
        const r = rng(seed);
        const r2 = rng(seed + 7);
        const rest = mix ? Array.from({ length: 6 }, () => weekMix(r2)).flat() : Array.from({ length: 35 }, (_, k) => (k % 2 === 0 ? "stressful_work" : "calm_desk") as Scenario);
        [...first, ...rest].slice(0, 35).forEach((s, d) => {
          const x = scoreDay(P, s, d, st.history, r);
          byDay[d].xs.push(x);
          if (st.history.length) byDay[d].ref.push(foldDaytimeBaseline(st.history).baseline - (P.sleepRhr + P.stillOffset));
          foldStill(st, x);
        });
      }
      return { ref: (d: number) => median(byDay[d].ref), caught: (d: number) => caught(byDay[d].xs), high: (d: number) => median(byDay[d].xs.map(highMinutes)) };
    } finally {
      earlyCleanConfig.days = keep;
    }
  }
  const ordinary = start([]);

  it.each([["illness"], ["hangover"]] as [Scenario][])("5 %s days first: the reference is the ordinary one from day 11, and calm days read stress again (version 51: none for weeks)", (s) => {
    const now = start(Array(5).fill(s));
    const v51 = start(Array(5).fill(s), 0);
    // Measured: reference +4.5 from day 11 (an ordinary start: +4.4); stress caught 61–70 % on day 11, calm days 41–49
    // high minutes. Version 51: +11.8 to +19.9 on day 11, +6.9 to +8.9 still on day 34; 0 high minutes on calm days.
    for (const d of [11, 14, 20, 34]) expect(Math.abs(now.ref(d) - ordinary.ref(d)), `day ${d}`).toBeLessThan(1.5);
    expect(now.caught(11)).toBeGreaterThan(0.5);
    for (const d of [12, 14, 20]) expect(now.high(d), `day ${d}`).toBeGreaterThan(20);
    expect(v51.ref(14) - ordinary.ref(14)).toBeGreaterThan(5);
    expect(v51.caught(11)).toBeLessThan(0.25);
    expect(v51.high(14)).toBe(0);
  }, 120_000);

  it("an ordinary start and a realistic week mix read as in version 51", () => {
    const ordinary51 = start([], 0);
    for (const d of [7, 14, 34]) expect(ordinary.ref(d)).toBeCloseTo(ordinary51.ref(d), 6);
    const mix = start([], earlyCleanConfig.days, true);
    const mix51 = start([], 0, true);
    for (const d of [7, 14, 34]) expect(Math.abs(mix.ref(d) - mix51.ref(d)), `day ${d}`).toBeLessThan(0.3);
  }, 120_000);
});
