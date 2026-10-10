// One early sensor glitch against the robust first week (SCORING_VERSION 32; docs/algorithms/baselines.md § Why
// version 32). 500 simulated people per case; each night's z is taken against the baseline folded from the nights
// before it, as Recovery does. sd(z) should be about 1. Deterministic.
import { describe, expect, it } from "vitest";
import { deviation, hrvCfg, restingHRCfg, update } from "./baselines";
import type { BaselineState, MetricCfg } from "./types";

let s = 3;
const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648), s / 2147483648);
const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
const sd = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

/** sd(z) and mean z over nights 7–14, and sd(z) over 15–30, for `mu ± wobble` with night `at` replaced by `glitch`. */
function zs(cfg: MetricCfg, mu: number, wobble: number, at?: number, glitch?: number, rejectHardOutliers = true) {
  const early: number[] = [];
  const later: number[] = [];
  for (let p = 0; p < 500; p++) {
    let st: BaselineState | null = null;
    for (let t = 1; t <= 30; t++) {
      const v = Math.max(cfg.minVal, t === at ? glitch! : mu + wobble * g());
      if (st && t >= 7 && t !== at) (t <= 14 ? early : later).push(deviation(v, st).z);
      st = update(st, v, cfg, rejectHardOutliers);
    }
  }
  return { week2: sd(early), meanZ: early.reduce((a, b) => a + b, 0) / early.length, weeks34: sd(later) };
}

describe("one early glitch no longer mutes Recovery for weeks", () => {
  // A glitch near the trim edge (90 ms, the 8 ms dropout: about 5σ) is sometimes kept, so it costs a little more.
  it.each([
    [90, 0.8, 0.12],
    [130, 0.88, 0.05],
    [180, 0.88, 0.05],
    [8, 0.8, 0.12],
  ])("HRV 50 ± 8 with night 3 at %i ms: sd(z) in nights 7–14 at least %f (version 31: 0.28–0.58)", (glitch, min, bias) => {
    const now = zs(hrvCfg, 50, 8, 3, glitch);
    expect(now.week2).toBeGreaterThanOrEqual(min);
    expect(Math.abs(now.meanZ)).toBeLessThanOrEqual(bias);
    // The plain young regime (the re-fold mode keeps it) is what version 31 did for every baseline.
    expect(zs(hrvCfg, 50, 8, 3, glitch, false).week2).toBeLessThan(0.65);
  });

  it("a glitch on the very first night (version 31: 0.13): at least 0.85", () => {
    expect(zs(hrvCfg, 50, 8, 1, 150).week2).toBeGreaterThanOrEqual(0.85);
    expect(zs(hrvCfg, 50, 8, 1, 150, false).week2).toBeLessThan(0.2);
  });

  it("resting HR 55 ± 2.5 with night 3 at 90 bpm (version 31: 0.31): at least 0.75", () => {
    expect(zs(restingHRCfg, 55, 2.5, 3, 90).week2).toBeGreaterThanOrEqual(0.75);
  });
});

describe("without a glitch it stays calibrated", () => {
  it.each([
    ["HRV 50 ± 8", hrvCfg, 50, 8],
    ["HRV 40 ± 14 (a large wobble)", hrvCfg, 40, 14],
    ["resting HR 60 ± 5", restingHRCfg, 60, 5],
  ] as const)("%s: sd(z) between 0.85 and 1.15 in weeks 2 and 3–4, mean z within 0.05", (_, cfg, mu, wobble) => {
    const r = zs(cfg, mu, wobble);
    for (const v of [r.week2, r.weeks34]) {
      expect(v).toBeGreaterThanOrEqual(0.85);
      expect(v).toBeLessThanOrEqual(1.15);
    }
    expect(Math.abs(r.meanZ)).toBeLessThanOrEqual(0.05);
  });
});
