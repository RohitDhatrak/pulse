// Spread floors that scale with the person (SCORING_VERSION 36; docs/algorithms/baselines.md § Why version 36). People
// at different HRV levels and resting-HR steadiness, 40 per cohort × 180 nights, scored as stage 2 does: each night against
// the prior baselines, then folded unless the illness hold holds it. Nights share an AR(1) "recovery state" (HRV up,
// resting HR down, φ 0.4) as in recovery.illness.sim.test.ts. Deterministic.
import { describe, expect, it } from "vitest";
import { hrvCfg, illnessWardZ, isUsable, nextHold, noHold, respCfg, restingHRCfg, skinTempCfg, update, zSigma, type HoldState } from "./baselines";
import { band, gatedRecovery, personalSleepCentre } from "./recovery";
import type { BaselineState, MetricCfg } from "./types";

type Night = { hrv: number; rhr: number; resp: number; skin: number; sleepPerf: number };
type Person = { hrv: number; cv: number; rhr: number; rhrSd: number };
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
function nights(p: Person, seed: number, count: number, mod: (i: number, n: Night) => Night = (_, n) => n): Night[] {
  const g = rng(seed);
  let latent = 0;
  return Array.from({ length: count }, (_, i) => {
    latent = 0.4 * latent + Math.sqrt(1 - 0.16) * g();
    const zH = 0.7 * latent + Math.sqrt(0.51) * g();
    const zR = -0.5 * latent + Math.sqrt(0.75) * g();
    return mod(i, {
      hrv: Math.exp(Math.log(p.hrv) - (p.cv * p.cv) / 2 + p.cv * zH),
      rhr: p.rhr + p.rhrSd * zR,
      resp: 15 + 0.4 * g(),
      skin: 34 + 0.25 * g(),
      sleepPerf: Math.min(1, Math.max(0.3, 0.85 + 0.05 * (0.3 * latent + 0.95 * g()))),
    });
  });
}

/** The floors before version 36: 5 ms and 2 bpm, fixed. */
const OLD = {
  hrv: { ...hrvCfg, floorSpread: 5, floorRel: undefined, youngFloorScale: undefined } as MetricCfg,
  rhr: { ...restingHRCfg, floorSpread: 2, youngFloorScale: undefined } as MetricCfg,
};
const NEW = { hrv: hrvCfg, rhr: restingHRCfg };

type Out = { z: number[]; rz: number[]; recs: number[]; hrvFlags: number; holds: number; nights: number; flagged: boolean[] };
/** Scores nights 30 on (and keeps every night's Health Monitor HRV flag), folding as stage 2 does. */
function run(ns: Night[], cfg: typeof NEW, out: Out) {
  let hrvB: BaselineState | null = null;
  let rhrB: BaselineState | null = null;
  let respB: BaselineState | null = null;
  let skinB: BaselineState | null = null;
  let h: HoldState = noHold;
  const perfs: number[] = [];
  out.flagged = [];
  ns.forEach((n, i) => {
    const centre = personalSleepCentre(perfs);
    const skinDev = skinB && isUsable(skinB) ? n.skin - skinB.baseline : null;
    const rec = hrvB
      ? gatedRecovery({ hrv: n.hrv, rhr: n.rhr, resp: n.resp, hrvBaseline: hrvB, rhrBaseline: rhrB && isUsable(rhrB) ? rhrB : null, respBaseline: respB && isUsable(respB) ? respB : null, sleepPerf: n.sleepPerf, sleepCentre: centre, skinTempDev: skinDev }).recovery
      : null;
    // The Health Monitor's range: the baseline ± 2.5σ (healthMonitor.ts).
    const flag = !!hrvB && isUsable(hrvB) && Math.abs(n.hrv - hrvB.baseline) > 2.5 * zSigma(hrvB);
    out.flagged.push(flag);
    const next = nextHold(h, illnessWardZ(n.hrv, n.rhr, hrvB, rhrB));
    if (i >= 30) {
      if (rec != null) out.recs.push(rec);
      if (hrvB && isUsable(hrvB)) out.z.push((n.hrv - hrvB.baseline) / zSigma(hrvB));
      if (rhrB && isUsable(rhrB)) out.rz.push((n.rhr - rhrB.baseline) / zSigma(rhrB));
      out.hrvFlags += +flag;
      out.holds += +next.hold;
      out.nights++;
    }
    h = { run: next.run, held: next.held };
    if (!next.hold) {
      perfs.push(n.sleepPerf);
      hrvB = update(hrvB, n.hrv, cfg.hrv);
      rhrB = update(rhrB, n.rhr, cfg.rhr);
      respB = update(respB, n.resp, respCfg);
      skinB = update(skinB, n.skin, skinTempCfg);
    }
  });
}

const sd = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};
const share = (xs: number[], b: "red" | "green") => xs.filter((v) => band(v) === b).length / xs.length;
const memo = new Map<string, Out & { dropCaught: number }>();
/** 40 people × 180 nights, plus each one's −25 % HRV for 3 nights from night 90 (the share of those nights flagged). */
function cohort(p: Person, cfg: typeof NEW) {
  const key = JSON.stringify([p, cfg === NEW]);
  if (memo.has(key)) return memo.get(key)!;
  const out: Out = { z: [], rz: [], recs: [], hrvFlags: 0, holds: 0, nights: 0, flagged: [] };
  let caught = 0;
  for (let k = 0; k < 40; k++) {
    run(nights(p, 10_000 + k, 180), cfg, out);
    const drop: Out = { z: [], rz: [], recs: [], hrvFlags: 0, holds: 0, nights: 0, flagged: [] };
    run(nights(p, 30_000 + k, 93, (i, n) => (i >= 90 ? { ...n, hrv: n.hrv * 0.75 } : n)), cfg, drop);
    caught += drop.flagged.slice(90).filter(Boolean).length;
  }
  const r = { ...out, dropCaught: caught / 120 };
  memo.set(key, r);
  return r;
}

const HEALTHY: Person = { hrv: 50, cv: 0.18, rhr: 58, rhrSd: 2.5 };
const COHORTS: [string, Person][] = [
  ["older, HRV 15 (CV 0.2)", { hrv: 15, cv: 0.2, rhr: 66, rhrSd: 2 }],
  ["older, HRV 22 (CV 0.15)", { hrv: 22, cv: 0.15, rhr: 64, rhrSd: 2 }],
  ["steady, HRV 25 (CV 0.08), resting HR ± 1.5", { hrv: 25, cv: 0.08, rhr: 62, rhrSd: 1.5 }],
  ["HRV 35 (CV 0.12)", { hrv: 35, cv: 0.12, rhr: 58, rhrSd: 2.5 }],
  ["steady, HRV 60 (CV 0.08)", { hrv: 60, cv: 0.08, rhr: 58, rhrSd: 2.5 }],
  ["typical, HRV 50 (CV 0.18)", HEALTHY],
  ["fit, HRV 100 (CV 0.15), resting HR 48 ± 1.5", { hrv: 100, cv: 0.15, rhr: 48, rhrSd: 1.5 }],
];

describe("HRV z is calibrated at every level (version 35: sd 0.32–0.75 below 60 ms)", () => {
  it.each(COHORTS)("%s: sd(z) of HRV and resting HR between 0.9 and 1.15", (_, p) => {
    const r = cohort(p, NEW);
    expect(sd(r.z)).toBeGreaterThanOrEqual(0.9);
    expect(sd(r.z)).toBeLessThanOrEqual(1.15);
    expect(sd(r.rz)).toBeGreaterThanOrEqual(0.9);
    expect(sd(r.rz)).toBeLessThanOrEqual(1.15);
  });

  it("the old fixed floors muted the low and steady cohorts (the audit's R4)", () => {
    expect(sd(cohort(COHORTS[1][1], OLD).z)).toBeLessThan(0.6); // measured 0.52
    expect(sd(cohort(COHORTS[2][1], OLD).z)).toBeLessThan(0.4); // 0.32
    expect(sd(cohort(COHORTS[2][1], OLD).rz)).toBeLessThan(0.65); // 0.58
  });

  it("above 100 ms the HRV floor never binds: nothing changes there", () => {
    expect(Math.abs(sd(cohort(COHORTS[6][1], NEW).z) - sd(cohort(COHORTS[6][1], OLD).z))).toBeLessThan(0.02);
  });
});

describe("Recovery reads the same for everyone (version 35: older cohorts 4–5 % red, 70–73 % yellow)", () => {
  const healthy = cohort(HEALTHY, NEW);
  it.each(COHORTS)("%s: red and green within 3 points of the typical cohort", (_, p) => {
    const r = cohort(p, NEW);
    expect(Math.abs(share(r.recs, "red") - share(healthy.recs, "red"))).toBeLessThanOrEqual(0.03);
    expect(Math.abs(share(r.recs, "green") - share(healthy.recs, "green"))).toBeLessThanOrEqual(0.03);
  });

  it("the typical cohort moves by at most 2 points (18.4 → 19.7 % red)", () => {
    expect(Math.abs(share(healthy.recs, "red") - share(cohort(HEALTHY, OLD).recs, "red"))).toBeLessThanOrEqual(0.02);
  });
});

describe("the Health Monitor's HRV range", () => {
  it.each(COHORTS)("%s: flags at most 1 healthy night in 30; the illness hold holds at most 4 %", (_, p) => {
    const r = cohort(p, NEW);
    expect(r.hrvFlags / r.nights).toBeLessThanOrEqual(1 / 30);
    expect(r.holds / r.nights).toBeLessThanOrEqual(0.04);
  });

  it("a −25 % HRV drop is flagged as often at 22 ms as at 100 ms with the same CV (version 35: never at 22 ms)", () => {
    const low = cohort(COHORTS[1][1], NEW).dropCaught;
    const fit = cohort(COHORTS[6][1], NEW).dropCaught;
    expect(Math.abs(low - fit)).toBeLessThanOrEqual(0.05);
    expect(cohort(COHORTS[1][1], OLD).dropCaught).toBe(0);
  });

  it("for a steady sleeper (CV 0.08) it is caught on most nights (version 35: never)", () => {
    expect(cohort(COHORTS[2][1], NEW).dropCaught).toBeGreaterThanOrEqual(0.6);
    expect(cohort(COHORTS[2][1], OLD).dropCaught).toBe(0);
  });
});
