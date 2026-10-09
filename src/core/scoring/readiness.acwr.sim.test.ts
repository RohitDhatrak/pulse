// ACWR on simulated people (SCORING_VERSION 27; docs/algorithms/training-load.md § Why version 27). 30 people per
// case through the real readiness.evaluate. Daily TRIMP is log-normal: rest days around 4, walks and sessions as
// named. Deterministic.
import { describe, expect, it } from "vitest";
import { evaluate } from "./readiness";

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
