// Tomorrow's Recovery forecast on simulated people (SCORING_VERSION 38; docs/algorithms/recovery-forecast.md § Why version
// 38). Each person's nights are scored and folded as stage 2 does (the illness hold included), and every evening's
// forecast is compared with the next morning's Recovery. No strain (the nudge is unchanged code). Version 37's forecast is
// kept below as a reference copy. Deterministic.
import { describe, expect, it } from "vitest";
import { hrvCfg, illnessWardZ, isUsable, nextHold, noHold, respCfg, restingHRCfg, skinTempCfg, update, type HoldState } from "./baselines";
import { forecast, mean } from "./forecast";
import { gatedRecovery, personalSleepCentre } from "./recovery";
import type { BaselineState } from "./types";

type Night = { hrv: number; rhr: number; resp: number; skin: number; sleepPerf: number };
type Person = { hrv: number; cv: number; rhr: number; rhrSd: number; phi: number; tails?: number };
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
      resp: 15 + 0.4 * r.n(),
      skin: 34 + 0.25 * r.n(),
      sleepPerf: Math.min(1, Math.max(0.3, 0.85 + 0.05 * (0.3 * latent + 0.95 * r.n()))),
    });
  });
}

/** Version 37's forecast with sleep neutral and no strain: the 14-day mean minus its slope (capped ±8). */
function v37(recent: number[]): number {
  const w = recent.slice(-14);
  const m = mean(w);
  const xm = (w.length - 1) / 2;
  let num = 0;
  let den = 0;
  w.forEach((v, i) => {
    num += (i - xm) * (v - m);
    den += (i - xm) ** 2;
  });
  const slope = den ? num / den : 0;
  return Math.round(Math.min(100, Math.max(0, m + Math.min(8, Math.max(-8, -slope)))));
}

type Pair = { day: number; fc: Record<string, number>; next: number };
/** Every evening's forecasts (from night 30, once 14 days are scored) with the next morning's Recovery. */
function evenings(ns: Night[]): Pair[] {
  let hrvB: BaselineState | null = null;
  let rhrB: BaselineState | null = null;
  let respB: BaselineState | null = null;
  let skinB: BaselineState | null = null;
  let h: HoldState = noHold;
  const perfs: number[] = [];
  const recs: number[] = [];
  const out: Pair[] = [];
  let pending: { day: number; fc: Record<string, number> } | null = null;
  ns.forEach((n, i) => {
    const centre = personalSleepCentre(perfs);
    const skinDev = skinB && isUsable(skinB) ? n.skin - skinB.baseline : null;
    const rec = hrvB
      ? gatedRecovery({ hrv: n.hrv, rhr: n.rhr, resp: n.resp, hrvBaseline: hrvB, rhrBaseline: rhrB && isUsable(rhrB) ? rhrB : null, respBaseline: respB && isUsable(respB) ? respB : null, sleepPerf: n.sleepPerf, sleepCentre: centre, skinTempDev: skinDev }).recovery
      : null;
    if (pending && rec != null) out.push({ ...pending, next: rec });
    pending = null;
    const next = nextHold(h, illnessWardZ(n.hrv, n.rhr, hrvB, rhrB));
    h = { run: next.run, held: next.held };
    if (!next.hold) perfs.push(n.sleepPerf);
    if (rec != null) {
      recs.push(rec);
      if (i >= 30 && recs.length >= 14) {
        const v38 = (sleep: boolean) => forecast({ recentCharge: recs, illnessHeld: next.hold, todayLoad: null, sleepPerfs: sleep ? perfs : [] })!.charge;
        pending = { day: i + 1, fc: { v37: v37(recs), mean14: mean(recs.slice(-14)), const58: 58, v38: v38(true), v38NoSleep: v38(false) } };
      }
    }
    if (!next.hold) {
      hrvB = update(hrvB, n.hrv, hrvCfg);
      rhrB = update(rhrB, n.rhr, restingHRCfg);
      respB = update(respB, n.resp, respCfg);
      skinB = update(skinB, n.skin, skinTempCfg);
    }
  });
  return out;
}

const ill = (n: Night): Night => ({ hrv: n.hrv * 0.7, rhr: n.rhr + 7, resp: n.resp + 1.5, skin: n.skin + 0.6, sleepPerf: n.sleepPerf - 0.08 });
const HEALTHY: Person = { hrv: 50, cv: 0.18, rhr: 58, rhrSd: 2.5, phi: 0.4 };
const SCENARIOS: [string, Person, ((i: number, n: Night) => Night) | undefined][] = [
  ["day-to-day independent (φ 0)", { ...HEALTHY, phi: 0 }, undefined],
  ["typical (φ 0.4)", HEALTHY, undefined],
  ["slow-moving (φ 0.8)", { ...HEALTHY, phi: 0.8 }, undefined],
  ["older, HRV 22", { ...HEALTHY, hrv: 22, cv: 0.15, rhr: 64, rhrSd: 2 }, undefined],
  ["heavy-tailed nights", { ...HEALTHY, tails: 3 }, undefined],
  ["periodic 5-night illnesses", HEALTHY, (i, n) => (i >= 40 && (i - 40) % 45 < 5 ? ill(n) : n)],
  // R9: a week of worse sleep every three weeks (a busy week, a new baby, travel), 10 points of Sleep Performance.
  ["poor-sleep weeks", HEALTHY, (i, n) => (i % 21 >= 14 ? { ...n, sleepPerf: n.sleepPerf - 0.1 } : n)],
];
const memo = new Map<string, Pair[]>();
const pairs = (name: string, p: Person, mod?: (i: number, n: Night) => Night) => {
  if (!memo.has(name)) memo.set(name, Array.from({ length: 60 }, (_, k) => evenings(nights(p, 50_000 + k, 200, mod))).flat());
  return memo.get(name)!;
};
const mae = (ps: Pair[], k: string) => mean(ps.map((x) => Math.abs(x.fc[k] - x.next)));

describe("the forecast beats trivial baselines (version 37: never better than a constant 58)", () => {
  it.each(SCENARIOS)("%s: no worse than the 14-day mean, and better than version 37", (name, p, mod) => {
    const ps = pairs(name, p, mod);
    expect(mae(ps, "v38")).toBeLessThanOrEqual(mae(ps, "mean14"));
    expect(mae(ps, "v38")).toBeLessThan(mae(ps, "v37") - 0.3);
    // A constant 58 is beaten everywhere but on independent days, where any personal estimate is noise (≤ 0.25 behind).
    expect(mae(ps, "v38")).toBeLessThanOrEqual(mae(ps, "const58") + (p.phi === 0 ? 0.25 : 0));
  });

  it("version 37's trend term was worse than its own 14-day mean in every scenario (the audit's R7)", () => {
    for (const [name, p, mod] of SCENARIOS) expect(mae(pairs(name, p, mod), "v37"), name).toBeGreaterThan(mae(pairs(name, p, mod), "mean14"));
  });
});

describe("around an illness (10 nights from night 120, 100 people)", () => {
  const ps = Array.from({ length: 100 }, (_, k) => evenings(nights(HEALTHY, 60_000 + k, 140, (i, n) => (i >= 120 && i < 130 ? ill(n) : n)))).flat();
  const signed = (k: string, from: number, to: number) => mean(ps.filter((x) => x.day >= from && x.day < to).map((x) => x.fc[k] - x.next));

  it("during it the forecast is at least 5 points less optimistic than version 37's", () => {
    expect(Math.abs(signed("v38", 121, 130))).toBeLessThanOrEqual(Math.abs(signed("v37", 121, 130)) - 5);
  });

  it("the week after, it no longer expects you to stay ill (version 37: about 34 points too low)", () => {
    expect(signed("v37", 130, 137)).toBeLessThan(-25);
    expect(Math.abs(signed("v38", 130, 137))).toBeLessThanOrEqual(10);
  });
});

describe("the sleep nudge (R9)", () => {
  // Forecast error with and without it (3 nights): poor-sleep weeks 18.33 vs 18.35, typical 18.31 vs 18.32, slow-moving
  // 17.04 vs 17.15, periodic illnesses 19.17 vs 19.20. Small, as expected: tonight's sleep is mostly its own.
  it("in poor-sleep weeks it makes the forecast more accurate", () => {
    const ps = pairs(...SCENARIOS[6]);
    expect(mae(ps, "v38")).toBeLessThan(mae(ps, "v38NoSleep"));
  });

  it.each(SCENARIOS.slice(0, 6))("%s: it costs at most 0.1 points", (name, p, mod) => {
    const ps = pairs(name, p, mod);
    expect(mae(ps, "v38")).toBeLessThanOrEqual(mae(ps, "v38NoSleep") + 0.1);
  });
});
