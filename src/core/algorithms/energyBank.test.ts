import { describe, expect, it } from "vitest";
import { recovery } from "../scoring/recovery";
import { energyBank, energyBankConfig, energyStart, minuteLoad, type EnergyBankInput } from "./energyBank";

const start = 1_790_000_000 - (1_790_000_000 % 86_400);
const N = 1440;
const ts = (h: number, min = 0) => start + (h * 60 + min) * 60;
const fill = <T>(v: T, f: (m: number) => T | undefined = () => undefined): T[] => Array.from({ length: N }, (_, m) => f(m) ?? v);
/** Medium stress all day (neither drains nor recharges), no load: only the basal drain. */
const day = (over: Partial<EnergyBankInput> = {}): EnergyBankInput => ({
  start,
  wake: ts(7),
  until: ts(23),
  recoveryWithoutSleep: 70,
  sleepPerformance: 80,
  load: fill<number | null>(0),
  stress: fill<number | null>(1.5),
  naps: [],
  ...over,
});
const inHour = (h: number) => (m: number) => m >= h * 60 && m < (h + 1) * 60;

describe("energyBank", () => {
  it("starts at wake at 0.6·Recovery without its sleep term + 0.4·sleep performance", () => {
    const r = energyBank(day());
    expect(r.startLevel).toBeCloseTo(0.6 * 70 + 0.4 * 80, 10);
    expect(r.curve[7 * 60 - 1]).toBeNull();
    expect(r.curve[7 * 60]).toBeCloseTo(74 - energyBankConfig.k0, 10);
    expect(r.curve[23 * 60]).toBeNull();
    expect(r.current).toBeCloseTo(74 - 16 * 60 * energyBankConfig.k0, 8);
  });

  it("a rest day drains less than a workout day", () => {
    const rest = energyBank(day());
    const load = fill<number | null>(0, (m) => (inHour(18)(m) ? 3 : undefined));
    const workout = energyBank(day({ load, workouts: [{ start: ts(18), end: ts(19), label: "Tempo run" }] }));
    expect(workout.current).toBeLessThan(rest.current);
    expect(rest.current - workout.current).toBeCloseTo(60 * 3 * energyBankConfig.k1, 8);
    expect(workout.topDrains[0]).toMatchObject({ label: "Tempo run", kind: "workout", start: ts(18), end: ts(19) });
  });

  it("high stress drains and calm still minutes recharge", () => {
    const base = energyBank(day()).current;
    expect(energyBank(day({ stress: fill<number | null>(1.5, (m) => (inHour(10)(m) ? 2.5 : undefined)) })).current).toBeLessThan(base);
    expect(energyBank(day({ stress: fill<number | null>(1.5, (m) => (inHour(10)(m) ? 0.3 : undefined)) })).current).toBeGreaterThan(base);
    // Unscored minutes (null) only carry the basal drain.
    expect(energyBank(day({ stress: fill<number | null>(null) })).current).toBeCloseTo(base, 10);
  });

  it("a nap raises the curve", () => {
    const nap = { start: ts(14), end: ts(14, 30) };
    const without = energyBank(day());
    const withNap = energyBank(day({ naps: [nap] }));
    expect(withNap.current).toBeGreaterThan(without.current);
    expect(withNap.curve[14 * 60 + 29]!).toBeGreaterThan(withNap.curve[14 * 60 - 1]!);
  });

  it("never leaves [0, 100]", () => {
    const drained = energyBank(day({ load: fill<number | null>(5), stress: fill<number | null>(3) }));
    expect(drained.current).toBe(0);
    const full = energyBank(day({ recoveryWithoutSleep: 100, sleepPerformance: 100, naps: [{ start: ts(7), end: ts(23) }] }));
    expect(full.current).toBe(100);
    for (const r of [drained, full]) for (const v of r.curve) if (v != null) expect(v >= 0 && v <= 100).toBe(true);
  });

  it("stops at `until` and reports the level there", () => {
    const r = energyBank(day({ until: ts(12) }));
    expect(r.curve[12 * 60 - 1]).toBe(r.current);
    expect(r.curve[12 * 60]).toBeNull();
  });

  it("lists at most three drains, largest first, joining close minutes into one episode", () => {
    const load = fill<number | null>(0, (m) =>
      // Activity 09:00–09:09 and 09:13–09:19 (one episode), a 3-min walk at 15:00, a workout at 18:00.
      (m >= 540 && m < 550) || (m >= 553 && m < 560) ? 1 : m >= 900 && m < 903 ? 1 : inHour(18)(m) ? 4 : undefined,
    );
    const stress = fill<number | null>(1.5, (m) => (m >= 600 && m < 640 ? 2.5 : undefined));
    const r = energyBank(day({ load, stress, workouts: [{ start: ts(18), end: ts(19), label: "Intervals" }] }));
    expect(r.topDrains.map((d) => d.label)).toEqual(["Intervals", "Stress", "Activity"]);
    expect(r.topDrains[2]).toMatchObject({ start: ts(9), end: ts(9, 20) });
    expect(r.topDrains[2].amount).toBeCloseTo(17 * energyBankConfig.k1, 10);
  });
});

describe("minuteLoad", () => {
  it("gives the Edwards zone weight by %HRR", () => {
    // RHR 60, HRmax 160: 50 % HRR is 110 bpm, 90 % is 150.
    expect(minuteLoad([null, 100, 110, 125, 150, 170], 60, 160)).toEqual([null, 0, 1, 2, 5, 5]);
  });
});

// ── Sleep counts once (SCORING_VERSION 20; docs/algorithms/energy-bank.md § Why) ──────────────────────────────────────
describe("energyStart", () => {
  it("is 0.6 · Recovery without its sleep term + 0.4 · sleep performance, within 0–100, and is what energyBank() starts at", () => {
    expect(energyStart(70, 80)).toBeCloseTo(74, 12);
    expect(energyStart(0, 0)).toBe(0);
    expect(energyStart(100, 100)).toBe(100);
    expect(energyStart(150, 150)).toBe(100);
    expect(energyStart(-20, 0)).toBe(0);
    expect(energyBank(day({ recoveryWithoutSleep: 55, sleepPerformance: 91 })).startLevel).toBe(energyStart(55, 91));
  });
});

describe("the start counts last night's sleep once, composed with the real recovery()", () => {
  // Baselines in z units: HRV, resting HR and breathing each mean 0, spread 1; usual sleep performance 0.88.
  const B = { hrvBaseline: { mean: 0, spread: 1 }, rhrBaseline: { mean: 0, spread: 1 }, respBaseline: { mean: 0, spread: 1 } };
  type Night = { hrvZ?: number; rhrZ?: number; sp?: number; centre?: number };
  const args = (n: Night) => ({ hrv: n.hrvZ ?? 0, rhr: n.rhrZ ?? 0, resp: 0, ...B, sleepCentre: n.centre ?? 0.88, skinTempDev: 0 });
  /** Version 20, as the pipeline composes it: Recovery with no sleep term, then energyStart. */
  const now = (n: Night) => energyStart(recovery({ ...args(n), sleepPerf: null })!, (n.sp ?? 0.88) * 100);
  /** Version 19: the shown Recovery (with its sleep term) and sleep performance again. */
  const v19 = (n: Night) => 0.6 * recovery({ ...args(n), sleepPerf: n.sp ?? 0.88 })! + 0.4 * (n.sp ?? 0.88) * 100;
  /** The fix list's rejected design: the shown Recovery alone. */
  const recoveryAlone = (n: Night) => recovery({ ...args(n), sleepPerf: n.sp ?? 0.88 })!;
  const perPoint = (f: (n: Night) => number, hrvZ: number) => (f({ hrvZ, sp: 0.89 }) - f({ hrvZ, sp: 0.87 })) / 2;

  it("one sleep performance point moves the start by exactly 0.4 at any HRV (version 19: 0.69, varying with HRV)", () => {
    for (const z of [-2, -1, 0, 1, 2]) expect(perPoint(now, z)).toBeCloseTo(0.4, 10);
    expect(perPoint(v19, 0)).toBeCloseTo(0.69, 2);
    expect(perPoint(v19, 2)).toBeLessThan(perPoint(v19, 0) - 0.05); // the logistic squashes the second count
  });

  it("a bad night (88 → 60) costs exactly 11.2 at every HRV level; Recovery alone ranges 8.7–13.9", () => {
    const costs = [-2, -1, 0, 1, 2].map((hrvZ) => now({ hrvZ }) - now({ hrvZ, sp: 0.6 }));
    for (const c of costs) expect(c).toBeCloseTo(11.2, 10);
    expect(v19({}) - v19({ sp: 0.6 })).toBeCloseTo(19.5, 1);
    const alone = [-2, -1, 0, 1, 2].map((hrvZ) => recoveryAlone({ hrvZ }) - recoveryAlone({ hrvZ, sp: 0.6 }));
    expect(Math.max(...alone) - Math.min(...alone)).toBeGreaterThan(4);
  });

  it("an HRV dip with normal sleep costs about what it did; Recovery alone would make it far larger", () => {
    const dip = { hrvZ: -2, rhrZ: 2 };
    const cost = now({}) - now(dip);
    const before = v19({}) - v19(dip);
    expect(Math.abs(cost - before)).toBeLessThan(3);
    expect(recoveryAlone({}) - recoveryAlone(dip)).toBeGreaterThan(cost + 10);
  });

  it("a chronic poor sleeper starts lower than a good sleeper (Recovery's relative sleep term alone can't show it)", () => {
    const poor = { sp: 0.78, centre: 0.78 };
    expect(now({}) - now(poor)).toBeCloseTo(4, 10);
    expect(recoveryAlone({}) - recoveryAlone(poor)).toBeCloseTo(0, 10);
  });

  it("20,000 simulated nights: the same scale as before, and sleep's share of the variation falls to the intended weight", () => {
    let x = 5;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648), x / 2147483648);
    const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
    const rows: { sp: number; a: number; b: number }[] = [];
    for (let i = 0; i < 20000; i++) {
      // Usual 88 ± 4, 5 % bad nights near 62; HRV a little lower after bad sleep.
      const sp = rnd() < 0.05 ? 62 + 6 * g() : 88 + 4 * g();
      const hrvZ = 0.25 * ((sp - 88) / 6) + Math.sqrt(1 - 0.0625) * g();
      const night = { hrvZ, rhrZ: -0.5 * hrvZ + 0.85 * g(), sp: sp / 100 };
      rows.push({ sp, a: now(night), b: v19(night) });
    }
    const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    const r2 = (y: number[], z: number[]) => {
      const my = mean(y), mz = mean(z);
      let sy = 0, sz = 0, syz = 0;
      for (let i = 0; i < y.length; i++) { syz += (y[i] - my) * (z[i] - mz); sy += (y[i] - my) ** 2; sz += (z[i] - mz) ** 2; }
      return (syz * syz) / (sy * sz);
    };
    const sp = rows.map((r) => r.sp);
    expect(Math.abs(mean(rows.map((r) => r.a)) - mean(rows.map((r) => r.b)))).toBeLessThan(1);
    const before = r2(rows.map((r) => r.b), sp);
    const after = r2(rows.map((r) => r.a), sp);
    // 0.33 → 0.21 on these nights.
    expect(before).toBeGreaterThan(0.3);
    expect(after).toBeLessThan(0.25);
    expect(after).toBeLessThan(before * 0.75);
  });
});
