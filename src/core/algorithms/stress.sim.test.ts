// Stress and the Energy Bank on generated days (SCORING_VERSION 21; docs/algorithms/stress.md § Why version 21).
// People are warmed up over 7 weeks of realistic mixed days, then scored on one scenario at a time, as the pipeline
// scores them (stage 1 masking with exertion, stage 2 against the gated baseline). Deterministic.
import { describe, expect, it } from "vitest";
import { foldableStillMedian } from "../scoring/stressBase";
import { caught, highMinutes, people, rng, scoreDay, warmUp, type Scenario, type ScoredDay } from "./__sim__/days";

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
