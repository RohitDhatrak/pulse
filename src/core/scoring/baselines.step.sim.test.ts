// A lasting real step against the restart rule (SCORING_VERSION 33; docs/algorithms/baselines.md § Why version 33).
// 60 simulated people per case: 90 normal nights, then a lasting step. Each night's z is taken against the baseline
// folded from the nights before it, as Recovery does. Deterministic.
import { describe, expect, it } from "vitest";
import { deviation, hrvCfg, restingHRCfg, update } from "./baselines";
import type { BaselineState, MetricCfg } from "./types";

let s = 5;
const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648), s / 2147483648);
const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
/** Student t with 3 degrees of freedom, scaled to unit variance: heavy-tailed nights. */
const t3 = () => {
  const z = g();
  let c = 0;
  for (let i = 0; i < 3; i++) c += g() ** 2;
  return z / Math.sqrt(c / 3) / Math.sqrt(3);
};

/** Median, over 60 people, of the nights after the step until a week's median |z| is at most 1 (999: never in 210). */
function nightsToFollow(cfg: MetricCfg, mu: number, sd: number, step: number): number {
  const until: number[] = [];
  for (let p = 0; p < 60; p++) {
    let st: BaselineState | null = null;
    const zs: number[] = [];
    let found = 999;
    for (let t = 1; t <= 300; t++) {
      const v = (t > 90 ? mu + step : mu) + sd * g();
      if (st && t > 90) zs.push(Math.abs(deviation(v, st).z));
      st = update(st, v, cfg);
      if (t > 96 && found === 999) {
        const week = zs.slice(-7).sort((a, b) => a - b);
        if (week[3] <= 1) found = t - 90;
      }
    }
    until.push(found);
  }
  return until.sort((a, b) => a - b)[30];
}

describe("a lasting step beyond the hard gate is followed (version 32: never)", () => {
  it.each([
    ["HRV 50 ± 8 → +60 ms (a new device)", hrvCfg, 50, 8, 60],
    ["resting HR 55 ± 2.5 → −18 bpm (a beta-blocker)", restingHRCfg, 55, 2.5, -18],
    ["HRV 50 ± 8 → +45 ms (version 32: 52 nights)", hrvCfg, 50, 8, 45],
    ["resting HR 55 ± 2.5 → −14 bpm (version 32: 34 nights)", restingHRCfg, 55, 2.5, -14],
  ] as const)("%s: back within |z| ≤ 1 in at most 20 nights", (_, cfg, mu, sd, step) => {
    expect(nightsToFollow(cfg, mu, sd, step)).toBeLessThanOrEqual(20);
  });

  it.each([
    ["HRV −30 ms", hrvCfg, 50, 8, -30],
    ["resting HR +12 bpm", restingHRCfg, 55, 2.5, 12],
  ] as const)("a step inside the gate (%s) is followed as before, within 26 nights", (_, cfg, mu, sd, step) => {
    expect(nightsToFollow(cfg, mu, sd, step)).toBeLessThanOrEqual(26);
  });
});

describe("no restart without a real step", () => {
  it.each([
    ["HRV 50 ± 8", hrvCfg, 50, 8],
    ["resting HR 55 ± 2.5", restingHRCfg, 55, 2.5],
  ] as const)("%s with heavy-tailed nights: no restart in 100 person-years", (_, cfg, mu, sd) => {
    let restarts = 0;
    for (let p = 0; p < 100; p++) {
      let st: BaselineState | null = null;
      for (let t = 1; t <= 365; t++) {
        const before = st?.nValid ?? 0;
        st = update(st, mu + sd * t3(), cfg);
        if (st.nValid < before) restarts++;
      }
    }
    expect(restarts).toBe(0);
  });
});
