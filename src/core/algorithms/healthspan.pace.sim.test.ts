// Pace of Aging on simulated people (SCORING_VERSION 28; docs/algorithms/healthspan.md § Why version 28). 60 people
// per case, 250 days: the first 220 fully worn, the last 30 worn ≥ 10 h awake only on the days named (the rest
// night-only: activity null). Habits: zones 1–3 150 and zones 4–5 30 min a week over 4 workouts, 8,500 steps,
// unless a case changes them for the last 30 days. Deterministic.
import { describe, expect, it } from "vitest";
import { healthspan, type HealthspanDay } from "./healthspan";

const DAY = 86_400_000;
const iso = (e: number) => new Date(e * DAY).toISOString().slice(0, 10);
type Rng = { rnd: () => number; g: () => number };
function rng(seed: number): Rng {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648), x / 2147483648);
  return { rnd, g: () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd()) };
}
type Habits = { z13: number; z45: number; steps: number };
const ACTIVE: Habits = { z13: 150, z45: 30, steps: 8500 };
const HALF: Habits = { z13: 75, z45: 15, steps: 6500 };
const SEDENTARY: Habits = { z13: 0, z45: 0, steps: 4000 };

function dayOf(e: number, h: Habits, r: Rng, worn: boolean): HealthspanDay {
  const workout = h.z13 > 0 && [0, 2, 4, 5].includes(((e % 7) + 7) % 7);
  return {
    day: iso(e),
    sleepHours: 7.1 + 0.7 * r.g(),
    sri: 80,
    restingHr: 60 + 2.5 * r.g(),
    vo2maxDaily: 45,
    steps: worn ? Math.max(500, h.steps * Math.exp(0.35 * r.g() - 0.06)) : null,
    zone13Min: worn ? (workout ? (h.z13 / 4) * (0.7 + 0.6 * r.rnd()) : 0) : null,
    zone45Min: worn ? (workout ? (h.z45 / 4) * (0.5 + r.rnd()) : 0) : null,
    strengthMin: worn ? 0 : null,
  };
}

const T0 = 20_000;
type Worn = (i: number, r: Rng) => boolean;
/** Paces of 60 people who change from `before` to `after` for the last 30 days, worn there on the days `worn` picks. */
function paces(before: Habits, after: Habits, worn: Worn, seed: number): number[] {
  return Array.from({ length: 60 }, (_, p) => {
    const r = rng(seed + p * 17);
    const mask = Array.from({ length: 30 }, (_, i) => worn(i, r));
    const days = Array.from({ length: 250 }, (_, i) => dayOf(T0 + i, i < 220 ? before : after, r, i < 220 || mask[i - 220]));
    return healthspan(days, { age: 40, sex: "male", heightCm: 178 }, iso(T0 + 249))!.paceOfAging;
  });
}
const outside = (ps: number[]) => ps.filter((x) => x < 0.9 || x > 1.1).length / ps.length;
const randomDays = (n: number): Worn => {
  let chosen = new Set<number>();
  return (i, r) => {
    if (i === 0) {
      chosen = new Set();
      while (chosen.size < n) chosen.add(Math.floor(r.rnd() * 30));
    }
    return chosen.has(i);
  };
};

describe("steady habits: a sparsely worn month doesn't swing Pace (version 27: 37–78 % outside 0.9–1.1)", () => {
  it.each([1, 8, 12])("%i random worn days in the last 30: at least 95 % inside 0.9–1.1", (n) => {
    expect(outside(paces(ACTIVE, ACTIVE, randomDays(n), 1000 + n))).toBeLessThanOrEqual(0.05);
  });

  it.each([14, 16, 20])("%i random worn days: at most 25 % outside (version 27: 28–43 %)", (n) => {
    expect(outside(paces(ACTIVE, ACTIVE, randomDays(n), 2000 + n))).toBeLessThanOrEqual(0.25);
  });

  it("fully worn, and weekends off: at most 5 % outside", () => {
    expect(outside(paces(ACTIVE, ACTIVE, () => true, 3000))).toBeLessThanOrEqual(0.05);
    expect(outside(paces(ACTIVE, ACTIVE, (i) => i % 7 < 5, 3100))).toBeLessThanOrEqual(0.05);
  });
});

describe("real changes still show", () => {
  it.each([
    ["fully worn", () => true],
    ["weekends off", (i: number) => i % 7 < 5],
    ["15 alternate days worn", (i: number) => i % 2 === 0],
  ] as const)("becoming sedentary, %s: every Pace over 1.5", (_, worn) => {
    expect(Math.min(...paces(ACTIVE, SEDENTARY, worn, 4000))).toBeGreaterThan(1.5);
  });

  it("half as active, fully worn: every Pace over 1.3; sedentary to active: every Pace under 0.5", () => {
    expect(Math.min(...paces(ACTIVE, HALF, () => true, 5000))).toBeGreaterThan(1.3);
    expect(Math.max(...paces(SEDENTARY, ACTIVE, () => true, 6000))).toBeLessThan(0.5);
  });
});
