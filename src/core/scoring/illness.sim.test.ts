// The illness signal on simulated nights (SCORING_VERSION 23; docs/algorithms/health-monitor.md § Why version 23).
// A typical person: resting HR 58 ± 2.5, HRV 50 ± 15 %, respiration 15 ± 0.5, skin ± 0.25 °C, night-to-night
// persistence 0.5, 10 % of nights missing. Effect sizes are assumptions. Deterministic.
import { describe, expect, it } from "vitest";
import { type IllnessDay, illnessFromDays, type IllnessContext } from "./illness";

function rng(seed: number) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
  return { rnd, g };
}
/** Full illness over 6 nights: resting HR +8, HRV −25 %, respiration +1.5, skin +0.6 °C at the peak. */
const ILLNESS = [0.4, 0.85, 1, 1, 0.9, 0.6];
type Opts = { illnessAt?: number; hardAt?: number };
function nights(seed: number, n: number, o: Opts = {}): IllnessDay[] {
  const r = rng(seed);
  const ar = { rhr: 0, hrv: 0, resp: 0, temp: 0 };
  return Array.from({ length: n }, (_, i) => {
    for (const k of Object.keys(ar) as (keyof typeof ar)[]) ar[k] = 0.5 * ar[k] + Math.sqrt(0.75) * r.g();
    const sev = o.illnessAt != null && i >= o.illnessAt ? (ILLNESS[i - o.illnessAt] ?? 0) : 0;
    const hard = o.hardAt === i ? 1 : 0;
    const miss = r.rnd() < 0.1 && sev === 0 && !hard;
    const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    if (miss) return { day: date };
    return {
      day: date,
      rhr: 58 + 2.5 * ar.rhr + 8 * sev + 6 * hard,
      hrv: 50 * Math.exp(0.15 * ar.hrv - 0.25 * sev) * (hard ? 0.7 : 1),
      resp: 15 + 0.5 * ar.resp + 1.5 * sev + 0.5 * hard,
      skinTempDev: 0.25 * ar.temp + 0.6 * sev + 0.2 * hard,
    };
  });
}
const level = (days: IllnessDay[], t: number, ctx: Omit<IllnessContext, "baselineTrusted"> = {}) => illnessFromDays(days.slice(0, t + 1), ctx).level;
const flags = (l: string) => l === "mild" || l === "raised";
const PEOPLE = 40;

describe("the illness signal on simulated people", () => {
  it("doesn't fade during an illness: from night 4 at least 45 % of sick nights read mild or more (version 22: 22 %)", () => {
    let late = 0, hit = 0, everRaised = 0;
    for (let p = 0; p < PEOPLE; p++) {
      const ds = nights(300 + p, 80, { illnessAt: 70 });
      let raised = false;
      for (let t = 70; t < 76; t++) {
        const l = level(ds, t);
        if (l === "raised") raised = true;
        if (t >= 73) {
          late++;
          if (flags(l)) hit++;
        }
      }
      if (raised) everRaised++;
    }
    expect(hit / late).toBeGreaterThanOrEqual(0.45);
    expect(everRaised / PEOPLE).toBeGreaterThanOrEqual(0.8); // version 22: 57 %
  });

  it("stays quiet on healthy nights", () => {
    let n = 0, f = 0;
    for (let p = 0; p < PEOPLE; p++) {
      const ds = nights(100 + p, 100);
      for (let t = 60; t < 100; t++) {
        if (ds[t].rhr == null) continue;
        n++;
        if (flags(level(ds, t))) f++;
      }
    }
    expect(f / n).toBeLessThanOrEqual(0.005);
  });

  it("a very hard or late session reads as illness without the context, and is explained with it", () => {
    let without = 0, withCtx = 0;
    for (let p = 0; p < PEOPLE; p++) {
      const ds = nights(700 + p, 80, { hardAt: 70 });
      if (flags(level(ds, 70))) without++;
      if (flags(level(ds, 70, { hardOrLateWorkout: true }))) withCtx++;
    }
    expect(without / PEOPLE).toBeGreaterThanOrEqual(0.3);
    expect(withCtx).toBe(0);
  });

  it("an illness starting the night after a flagged session is still raised on a later night", () => {
    let caught = 0;
    for (let p = 0; p < PEOPLE; p++) {
      const ds = nights(800 + p, 80, { illnessAt: 70 });
      // The context covers only its own night (the first sick night); later nights are scored as usual.
      const nightly = [level(ds, 70, { hardOrLateWorkout: true }), ...[71, 72, 73, 74, 75].map((t) => level(ds, t))];
      if (nightly.slice(1).some((l) => l === "raised")) caught++;
    }
    expect(caught / PEOPLE).toBeGreaterThanOrEqual(0.8);
  });
});
