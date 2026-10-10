// Recovery around an illness on simulated nights (SCORING_VERSION 30; docs/algorithms/baselines.md § Why version 30).
// Mirrors stage 2: each night is scored against the prior baselines, then folded, unless the illness hold holds it.
// Nights come from a shared AR(1) "recovery state" (HRV up, resting HR down), with personal means jittered; 100
// people per case. Illness: HRV −30 %, resting HR +7, respiration +1.5, skin +0.6 °C, sleep −8 points. Deterministic.
import { describe, expect, it } from "vitest";
import { hrvCfg, illnessWardZ, isUsable, nextHold, noHold, respCfg, restingHRCfg, skinTempCfg, update, type HoldState } from "./baselines";
import { band, gatedRecovery, personalSleepCentre } from "./recovery";
import type { BaselineState } from "./types";

type Night = { hrv: number; rhr: number; resp: number; skin: number; sleepPerf: number };
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
  return { u, n };
}
/** One person's nights: HRV 50 ms (CV 0.18) and resting HR 58 ± 2.5, each jittered per person; AR(1) φ 0.4. */
function nights(seed: number, count: number, mod: (i: number, n: Night) => Night = (_, n) => n): Night[] {
  const r = rng(seed);
  const hrvMu = 50 * Math.exp(0.15 * r.n());
  const rhrMu = 58 + 3 * r.n();
  let latent = 0;
  return Array.from({ length: count }, (_, i) => {
    latent = 0.4 * latent + Math.sqrt(1 - 0.16) * r.n();
    const zH = 0.7 * latent + Math.sqrt(0.51) * r.n();
    const zR = -0.5 * latent + Math.sqrt(0.75) * r.n();
    const n: Night = {
      hrv: Math.exp(Math.log(hrvMu) - 0.0162 + 0.18 * zH),
      rhr: rhrMu + 2.5 * zR,
      resp: 15 + 0.4 * r.n(),
      skin: 34 + 0.25 * r.n(),
      sleepPerf: Math.min(1, Math.max(0.3, 0.85 + 0.05 * (0.3 * latent + 0.95 * r.n()))),
    };
    return mod(i, n);
  });
}
/** Recovery per night, scoring then folding as stage 2 does; `hold: false` is version 29 (fold every night). */
function recoveries(ns: Night[], hold = true): number[] {
  let hrvB: BaselineState | null = null;
  let rhrB: BaselineState | null = null;
  let respB: BaselineState | null = null;
  let skinB: BaselineState | null = null;
  let h: HoldState = noHold;
  const perfs: number[] = [];
  return ns.map((n) => {
    const centre = personalSleepCentre(perfs);
    const skinDev = skinB && isUsable(skinB) ? n.skin - skinB.baseline : null;
    const rec = hrvB
      ? gatedRecovery({ hrv: n.hrv, rhr: n.rhr, resp: n.resp, hrvBaseline: hrvB, rhrBaseline: rhrB && isUsable(rhrB) ? rhrB : null, respBaseline: respB && isUsable(respB) ? respB : null, sleepPerf: n.sleepPerf, sleepCentre: centre, skinTempDev: skinDev }).recovery
      : null;
    const next = nextHold(h, illnessWardZ(n.hrv, n.rhr, hrvB, rhrB));
    h = { run: next.run, held: next.held };
    if (!(hold && next.hold)) {
      perfs.push(n.sleepPerf);
      hrvB = update(hrvB, n.hrv, hrvCfg);
      rhrB = update(rhrB, n.rhr, restingHRCfg);
      respB = update(respB, n.resp, respCfg);
      skinB = update(skinB, n.skin, skinTempCfg);
    }
    return rec ?? NaN;
  });
}
const ill = (n: Night): Night => ({ hrv: n.hrv * 0.7, rhr: n.rhr + 7, resp: n.resp + 1.5, skin: n.skin + 0.6, sleepPerf: n.sleepPerf - 0.08 });
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const share = (xs: number[], b: "green" | "red") => xs.filter((v) => band(v) === b).length / xs.length;
/** Nights [from, to) relative to an illness of `len` nights starting on night 100, over 100 people. */
function around(len: number, from: number, to: number, hold = true) {
  return Array.from({ length: 100 }, (_, k) => recoveries(nights(20000 + k, 150, (i, n) => (i >= 100 && i < 100 + len ? ill(n) : n)), hold).slice(100 + from, 100 + to)).flat();
}

describe("after an illness Recovery isn't unusually green (version 29: 51 / 62 / 82 % green the week after)", () => {
  it("the week before is about a third green", () => {
    expect(share(around(21, -20, 0), "green")).toBeLessThan(0.4);
  });

  it.each([
    [5, 0.42],
    [10, 0.42],
    [21, 0.5],
  ])("a %i-night illness: the next week at most %f green", (len, max) => {
    expect(share(around(len, len, len + 7), "green")).toBeLessThanOrEqual(max);
    expect(share(around(len, len, len + 7, false), "green")).toBeGreaterThan(max); // version 29
  });

  it("a 21-night illness stays red: at least 90 % of its nights (version 29: 71 %)", () => {
    expect(share(around(21, 0, 21), "red")).toBeGreaterThanOrEqual(0.9);
  });
});

describe("what the hold must not do", () => {
  it("a healthy year reads within 1 point of folding every night", () => {
    const held: number[] = [];
    const plain: number[] = [];
    for (let k = 0; k < 100; k++) {
      const ns = nights(9000 + k, 150);
      held.push(...recoveries(ns).slice(40));
      plain.push(...recoveries(ns, false).slice(40));
    }
    expect(Math.abs(mean(held) - mean(plain))).toBeLessThanOrEqual(1);
  });

  it("a lasting drop (HRV −22 %, resting HR +4) is still absorbed: back to at least 50 by weeks 8–9", () => {
    const step = (i: number, n: Night): Night => (i >= 100 ? { ...n, hrv: n.hrv * 0.78, rhr: n.rhr + 4 } : n);
    const weeks89 = Array.from({ length: 100 }, (_, k) => recoveries(nights(30000 + k, 175, step)).slice(149, 163)).flat();
    expect(mean(weeks89)).toBeGreaterThanOrEqual(50);
  });
});
