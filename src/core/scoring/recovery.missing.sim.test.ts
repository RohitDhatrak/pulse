// Recovery with missing inputs (SCORING_VERSION 37; docs/algorithms/recovery-missing-inputs.md). Simulated people,
// 60 per cohort × 180 nights, scored and folded as stage 2 does (the illness hold included); each night is then scored
// again with only a subset of its inputs, as a phone or Health Connect night, or a young baseline, would give it. On
// healthy nights every subset should read like the full set. Nights share an AR(1) "recovery state" (HRV up, resting HR
// down, sleep a little better), as in recovery.illness.sim.test.ts. Deterministic.
import { describe, expect, it } from "vitest";
import { hrvCfg, illnessWardZ, isUsable, nextHold, noHold, respCfg, restingHRCfg, skinTempCfg, update, type HoldState } from "./baselines";
import { band, gatedRecovery, personalSleepCentre, type RecoveryTerm } from "./recovery";
import type { BaselineState } from "./types";

type Night = { hrv: number; rhr: number; resp: number; skin: number; sleepPerf: number };
type Person = { hrv: number; cv: number; rhr: number; rhrSd: number; phi: number; tails?: number; sleepSd?: number; respSd?: number };
function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = () => Math.sqrt(-2 * Math.log(Math.max(u(), 1e-12))) * Math.cos(2 * Math.PI * u());
  /** Student t with `df` degrees of freedom, scaled to unit variance. */
  const t = (df: number) => {
    let c = 0;
    for (let i = 0; i < df; i++) c += n() ** 2;
    return n() / Math.sqrt(c / df) / Math.sqrt(df / (df - 2));
  };
  return { n, t };
}
function nights(p: Person, seed: number, count: number, mod: (i: number, n: Night) => Night = (_, n) => n): Night[] {
  const r = rng(seed);
  const e = () => (p.tails ? r.t(p.tails) : r.n());
  const hrvMu = p.hrv * Math.exp(0.15 * r.n());
  const rhrMu = p.rhr + 3 * r.n();
  let latent = 0;
  return Array.from({ length: count }, (_, i) => {
    latent = p.phi * latent + Math.sqrt(1 - p.phi * p.phi) * e();
    const zH = 0.7 * latent + Math.sqrt(0.51) * e();
    const zR = -0.5 * latent + Math.sqrt(0.75) * e();
    return mod(i, {
      hrv: Math.exp(Math.log(hrvMu) - (p.cv * p.cv) / 2 + p.cv * zH),
      rhr: rhrMu + p.rhrSd * zR,
      resp: 15 + (p.respSd ?? 0.4) * r.n(),
      skin: 34 + 0.25 * r.n(),
      sleepPerf: Math.min(1, Math.max(0.3, 0.85 + (p.sleepSd ?? 0.05) * (0.3 * latent + 0.95 * r.n()))),
    });
  });
}

/** Each night's Recovery with only `keep` of its inputs (HRV is always there), from nights 30 on. */
function recoveries(ns: Night[], keep: RecoveryTerm[]): number[] {
  let hrvB: BaselineState | null = null;
  let rhrB: BaselineState | null = null;
  let respB: BaselineState | null = null;
  let skinB: BaselineState | null = null;
  let h: HoldState = noHold;
  const perfs: number[] = [];
  const out: number[] = [];
  const has = (t: RecoveryTerm) => keep.includes(t);
  ns.forEach((n, i) => {
    const centre = personalSleepCentre(perfs);
    const skinDev = skinB && isUsable(skinB) ? n.skin - skinB.baseline : null;
    if (hrvB && i >= 30) {
      const rec = gatedRecovery({
        hrv: n.hrv,
        rhr: has("rhr") ? n.rhr : null,
        resp: has("resp") ? n.resp : null,
        hrvBaseline: hrvB,
        rhrBaseline: has("rhr") && rhrB && isUsable(rhrB) ? rhrB : null,
        respBaseline: has("resp") && respB && isUsable(respB) ? respB : null,
        sleepPerf: has("sleep") ? n.sleepPerf : null,
        sleepCentre: centre,
        skinTempDev: has("skin") ? skinDev : null,
      }).recovery;
      if (rec != null) out.push(rec);
    }
    const next = nextHold(h, illnessWardZ(n.hrv, n.rhr, hrvB, rhrB));
    h = { run: next.run, held: next.held };
    if (!next.hold) {
      perfs.push(n.sleepPerf);
      hrvB = update(hrvB, n.hrv, hrvCfg);
      rhrB = update(rhrB, n.rhr, restingHRCfg);
      respB = update(respB, n.resp, respCfg);
      skinB = update(skinB, n.skin, skinTempCfg);
    }
  });
  return out;
}

const ALL: RecoveryTerm[] = ["hrv", "rhr", "resp", "sleep", "skin"];
const SETS: [string, RecoveryTerm[]][] = [
  ["no skin temperature", ["hrv", "rhr", "resp", "sleep"]],
  ["no breathing or skin temperature", ["hrv", "rhr", "sleep"]],
  ["HRV and resting HR", ["hrv", "rhr"]],
  ["HRV and sleep", ["hrv", "sleep"]],
  ["HRV only", ["hrv"]],
];
const HEALTHY: Person = { hrv: 50, cv: 0.18, rhr: 58, rhrSd: 2.5, phi: 0.4 };
const COHORTS: [string, Person][] = [
  ["typical", HEALTHY],
  ["older, HRV 22", { hrv: 22, cv: 0.15, rhr: 64, rhrSd: 2, phi: 0.4 }],
  ["heavy-tailed nights", { ...HEALTHY, tails: 3 }],
  ["slow-moving recovery state (φ 0.8)", { ...HEALTHY, phi: 0.8 }],
  // Robustness: sleep and breathing noisier than the spreads termSd assumes.
  ["noisier sleep and breathing", { ...HEALTHY, sleepSd: 0.1, respSd: 0.8 }],
];

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const memo = new Map<string, { red: number; green: number; swing: number }>();
function stats(p: Person, keep: RecoveryTerm[]) {
  const key = JSON.stringify([p, keep]);
  if (!memo.has(key)) {
    const recs: number[] = [];
    const swings: number[] = [];
    for (let k = 0; k < 60; k++) {
      const v = recoveries(nights(p, 20_000 + k, 180), keep);
      recs.push(...v);
      for (let i = 1; i < v.length; i++) swings.push(Math.abs(v[i] - v[i - 1]));
    }
    const share = (b: string) => recs.filter((x) => band(x) === b).length / recs.length;
    memo.set(key, { red: share("red"), green: share("green"), swing: mean(swings) });
  }
  return memo.get(key)!;
}

describe("a night with fewer inputs reads like a full one (version 36 HRV only: 30 % red, swing 29.5 vs 20 %, 22.6)", () => {
  for (const [cohort, p] of COHORTS) {
    it.each(SETS)(`${cohort}, %s: red and green within 3 points, the swing within 2`, (_, keep) => {
      const full = stats(p, ALL);
      const part = stats(p, keep);
      expect(Math.abs(part.red - full.red)).toBeLessThanOrEqual(0.03);
      expect(Math.abs(part.green - full.green)).toBeLessThanOrEqual(0.03);
      expect(Math.abs(part.swing - full.swing)).toBeLessThanOrEqual(2);
    });
  }
});

// The cost: a fewer-input night is weaker evidence, so a real event reads a little milder there. Version 36 → 37, share of
// red nights: a 5-night illness 97 → 97 % with every input, 97 → 95 % with HRV and resting HR, 92 → 86 % with HRV only;
// a night after drinking 88 → 88 %, 92 → 89 %, 83 → 75 %.
describe("real events still show with fewer inputs", () => {
  const ill = (n: Night): Night => ({ hrv: n.hrv * 0.7, rhr: n.rhr + 7, resp: n.resp + 1.5, skin: n.skin + 0.6, sleepPerf: n.sleepPerf - 0.08 });
  /** The share of red nights during an event of `len` nights from night 100, over 100 people. */
  const red = (keep: RecoveryTerm[], len: number, f: (n: Night) => Night) => {
    const recs = Array.from({ length: 100 }, (_, k) =>
      recoveries(nights(HEALTHY, 40_000 + k, 100 + len, (i, n) => (i >= 100 ? f(n) : n)), keep).slice(-len),
    ).flat();
    return recs.filter((x) => band(x) === "red").length / recs.length;
  };

  it.each([["every input", ALL], ...SETS] as [string, RecoveryTerm[]][])("a 5-night illness is at least 85 %% red: %s", (_, keep) => {
    expect(red(keep, 5, ill)).toBeGreaterThanOrEqual(0.85);
  });

  it.each([["every input", ALL], ["HRV and resting HR", ["hrv", "rhr"]], ["HRV only", ["hrv"]]] as [string, RecoveryTerm[]][])(
    "a night after drinking (HRV −25 %%, resting HR +5) is red at least 70 %% of the time: %s",
    (_, keep) => {
      expect(red(keep, 1, (n) => ({ ...n, hrv: n.hrv * 0.75, rhr: n.rhr + 5 }))).toBeGreaterThanOrEqual(0.7);
    },
  );
});
