// The Sleep score's restorative targets by age on simulated sleepers (SCORING_VERSION 43, audit S8;
// docs/algorithms/sleep-need.md § Why version 43). Deep and REM shares follow age norms with Ohayon 2004's slopes (slow-wave
// sleep about −2 points a decade from 20 to 60, then flat; REM about −0.6), scaled so a 35-year-old's deep is a Fitbit-like
// 15 %. These norms are an assumption, independent of the targets' 0.7 / 0.84 ratios. 200 people per case, 60 nights,
// each with their own shares and night-to-night variation; duration, efficiency and consistency are the same at every
// age. Version 42's component is kept as a reference copy. Deterministic.
import { describe, expect, it } from "vitest";
import { rest, restorativeScore } from "./sleep";

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

const H = 3600;
/** Sleep-lab norms (percent of sleep) with Ohayon's slopes, flat from 60; scaled to the band below. */
const swsLab = (age: number) => 20 - 0.2 * (Math.min(age, 60) - 20);
const remLab = (age: number) => 22 - 0.06 * (Math.min(age, 60) - 20);
const FITBIT = 15 / swsLab(35);
const deepNorm = (age: number) => (swsLab(age) * FITBIT) / 100;
const remNorm = (age: number) => remLab(age) / 100;

/** Version 42's restorative component: 50 % deep + REM and 13 % deep at every age. */
const v42 = (deep: number, rem: number, asleep: number) =>
  Math.min(100, ((deep + rem) / asleep / 0.5) * 100) * (0.5 + 0.5 * Math.min(1, Math.max(0, deep / asleep / 0.13)));

type Night = { now: number; before: number; restNow: number; restBefore: number };
/** Each night's Sleep Performance and restorative component, now and in version 42. `deepScale` lowers deep sleep. */
function sleepers(age: number, seed: number, deepScale = 1): Night[] {
  const out: Night[] = [];
  for (let k = 0; k < 200; k++) {
    const g = rng(seed * 1000 + k);
    const ownDeep = deepNorm(age) * deepScale + 0.015 * g();
    const ownRem = remNorm(age) + 0.02 * g();
    const ownHours = 7.4 + 0.3 * g();
    for (let i = 0; i < 60; i++) {
      const hours = Math.max(4, ownHours + 0.5 * g());
      const asleep = hours * H;
      const deep = Math.max(0, ownDeep + 0.025 * g()) * asleep;
      const rem = Math.max(0, ownRem + 0.03 * g()) * asleep;
      const eff = Math.min(0.97, 0.88 + 0.03 * g());
      const restNow = restorativeScore(deep, rem, asleep, age);
      const restBefore = v42(deep, rem, asleep);
      out.push({
        restNow,
        restBefore,
        now: rest(asleep, eff, deep, rem, 7.4, 0.8, { ageYears: age })!,
        before: rest(asleep, eff, null, null, 7.4, 0.8, { usualRestorative: restBefore })!,
      });
    }
  }
  return out;
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const score = (r: Night[], k: keyof Night) => mean(r.map((n) => n[k]));

const r35 = sleepers(35, 1);
const r50 = sleepers(50, 2);
const r70 = sleepers(70, 3);

describe("healthy sleepers for their age (audit S8)", () => {
  it("a 70-year-old's Sleep Performance is within a point of a 35-year-old's (version 42: 3.6 behind)", () => {
    expect(score(r35, "before") - score(r70, "before")).toBeGreaterThan(3); // 88.4 vs 84.7
    expect(Math.abs(score(r35, "now") - score(r70, "now"))).toBeLessThanOrEqual(1); // 88.4 vs 87.9
  });

  it("a 50-year-old falls in between, closer to the 35-year-old than before", () => {
    expect(Math.abs(score(r35, "now") - score(r50, "now"))).toBeLessThan(score(r35, "before") - score(r50, "before"));
    expect(Math.abs(score(r35, "now") - score(r50, "now"))).toBeLessThanOrEqual(1); // 0.6 (version 42: 2.0)
  });

  it("under 40 every night scores exactly as in version 42", () => {
    for (const n of r35) expect(n.restNow).toBe(n.restBefore);
  });
});

describe("what must still count", () => {
  it("a 70-year-old with half the usual deep sleep for their age still scores well below a healthy one", () => {
    const low = sleepers(70, 4, 0.5);
    expect(score(r70, "now") - score(low, "now")).toBeGreaterThanOrEqual(3); // 87.9 vs 83.7
    expect(score(r70, "restNow") - score(low, "restNow")).toBeGreaterThanOrEqual(15); // restorative 70 vs 48
  });
});
