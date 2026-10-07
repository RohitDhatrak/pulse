import { describe, expect, it } from "vitest";
import { zShrinkK } from "./baselines";
import { forCharge } from "./confidence";
import { baselineVerdict, chargeDrivers, displayRounded, skinTempVerdict, type ChargeDriverVerdict } from "./drivers";
import { logisticScore, recoveryFromStates } from "./recovery";
import type { BaselineState, BaselineStatus } from "./types";

const baseline = (mean: number, sigma: number, nValid = 14): BaselineState => ({
  baseline: mean,
  spread: sigma / 1.253,
  nValid,
  nightsSinceUpdate: 0,
  status: nValid >= 14 ? "trusted" : "provisional",
});
/**
 * A trusted baseline whose z-score spread (after the n / (n + k) shrink) is exactly `spread`, so the exact
 * half-tie inputs below stay ties. The pre-scale round-trips bit-exactly for every spread used here.
 */
const raw = (mean: number, spread: number): BaselineState => ({
  baseline: mean,
  spread: (spread * 14) / (14 + zShrinkK),
  nValid: 14,
  nightsSinceUpdate: 0,
  status: "trusted",
});
const row = (drivers: ReturnType<typeof chargeDrivers>, label: string) => drivers.find((d) => d.label === label)!;

describe("RecoveryDriversTest", () => {
  it("point rounding is nearest with half-ties away from zero", () => {
    const marginal = (hrv: number, rhr: number, hrvBaseline: BaselineState, rhrBaseline: BaselineState | null = null) => {
      const full = recoveryFromStates({ hrv, rhr, hrvBaseline, rhrBaseline })!;
      const neutral = recoveryFromStates({ hrv: hrvBaseline.baseline, rhr, hrvBaseline, rhrBaseline })!;
      const r = row(chargeDrivers({ hrv, rhr, hrvBaseline, rhrBaseline }), "HEART_RATE_VARIABILITY");
      return [full - neutral, r.deltaPoints] as const;
    };
    const neg = raw(30, 0.55);
    const nBelow = marginal(29.991177275907276, 60, neg);
    const nBeyond = marginal(29.991177240671185, 60, neg);
    expect(nBelow[0]).toBeGreaterThan(-0.5);
    expect(nBelow[1]).toBe(0);
    expect(nBeyond[0]).toBeLessThan(-0.5);
    expect(nBeyond[1]).toBe(-1);
    // noop's exact tie (29.99117725828923) lands one ULP short of -0.5 here: V8's Math.exp differs from the
    // JVM / Swift libm by an ULP. Same rule on a tie that is exact under V8:
    expect(marginal(29.99117725828923, 60, neg)[0]).toBeCloseTo(-0.5, 12);
    const nTie = marginal(29.987696285650618, 60, raw(30, 0.767));
    expect(nTie[0]).toBe(-0.5);
    expect(nTie[1]).toBe(-1);

    const posRhr = raw(60, 0.1);
    const pBelow = marginal(33.09890762408082, 58.541, neg, posRhr);
    const pTie = marginal(33.099135135290354, 58.541, neg, posRhr);
    const pBeyond = marginal(33.09936273466694, 58.541, neg, posRhr);
    expect(pBelow[0]).toBeLessThan(0.5);
    expect(pBelow[1]).toBe(0);
    expect(pTie[0]).toBe(0.5);
    expect(pTie[1]).toBe(1);
    expect(pBeyond[0]).toBeGreaterThan(0.5);
    expect(pBeyond[1]).toBe(1);
  });

  it("issue 51: a negative half-tie row (V8-exact tie, see above)", () => {
    const hrvBaseline = raw(30, 0.767);
    const hrv = 29.987696285650618;
    const before = recoveryFromStates({ hrv, rhr: 60, hrvBaseline })!;
    const neutral = recoveryFromStates({ hrv: 30, rhr: 60, hrvBaseline })!;
    expect(before - neutral).toBe(-0.5);
    expect(chargeDrivers({ hrv, rhr: 60, hrvBaseline })).toEqual([
      {
        label: "HEART_RATE_VARIABILITY",
        deltaPoints: -1,
        value: hrv,
        baseline: 30,
        unit: "MILLISECONDS",
        verdict: "SLIGHTLY_BELOW_BASELINE_LIMITING",
      },
    ]);
  });

  it("verdicts match displayed precision and rounded points", () => {
    const cases: [number, number, number, number, ChargeDriverVerdict][] = [
      [51.3, 50.8, 1, 0, "SLIGHTLY_ABOVE_BASELINE_SUPPORTING"],
      [51.3, 50.8, -1, 0, "SLIGHTLY_ABOVE_BASELINE_LIMITING"],
      [50.8, 51.3, 1, 0, "SLIGHTLY_BELOW_BASELINE_SUPPORTING"],
      [50.8, 51.3, -1, 0, "SLIGHTLY_BELOW_BASELINE_LIMITING"],
      [17.0, 16.0, 0, 1, "ABOVE_BASELINE_TOO_SMALL"],
      [15.0, 16.0, 0, 1, "BELOW_BASELINE_TOO_SMALL"],
      [51.3, 50.8, 0, 0, "AT_BASELINE"],
    ];
    for (const [value, base, points, digits, expected] of cases) {
      expect(baselineVerdict(value, base, points, digits)).toBe(expected);
    }
  });

  it("skin-temp verdict uses the rounded point effect", () => {
    expect(skinTempVerdict(0.2, 0)).toBe("NEAR_BASELINE");
    expect(skinTempVerdict(0.2, -1)).toBe("WARMER_THAN_BASELINE_LIMITING");
    expect(skinTempVerdict(-0.2, -1)).toBe("COOLER_THAN_BASELINE_LIMITING");
  });

  it("an RHR row cannot say above when the displayed values match", () => {
    const d = chargeDrivers({ hrv: 50, rhr: 51.3, hrvBaseline: baseline(50, 6), rhrBaseline: baseline(50.8, 0.1) });
    const rhr = row(d, "RESTING_HEART_RATE");
    expect(Math.round(rhr.value)).toBe(51);
    expect(Math.round(rhr.baseline!)).toBe(51);
    expect(rhr.deltaPoints).toBeLessThan(0);
    expect(rhr.verdict).toBe("SLIGHTLY_ABOVE_BASELINE_LIMITING");
  });

  it("all terms present yield one row each, biggest mover first", () => {
    const d = chargeDrivers({
      hrv: 62,
      rhr: 51,
      resp: 15,
      hrvBaseline: baseline(50, 6),
      rhrBaseline: baseline(55, 3),
      respBaseline: baseline(16, 2),
      sleepPerf: 0.9,
      skinTempDev: 0.3,
    });
    expect(new Set(d.map((r) => r.label))).toEqual(
      new Set(["HEART_RATE_VARIABILITY", "RESTING_HEART_RATE", "SLEEP_QUALITY", "RESPIRATORY_RATE", "SKIN_TEMPERATURE"]),
    );
    const mags = d.map((r) => Math.abs(r.deltaPoints));
    expect(mags).toEqual([...mags].sort((a, b) => b - a));
    for (const label of ["HEART_RATE_VARIABILITY", "RESTING_HEART_RATE", "RESPIRATORY_RATE"]) {
      expect(row(d, label).baseline).not.toBeNull();
    }
    expect(row(d, "HEART_RATE_VARIABILITY")).toMatchObject({ value: 62, baseline: 50, unit: "MILLISECONDS" });
  });

  it("a missing input yields no row, not a fake zero", () => {
    const labels = chargeDrivers({ hrv: 55, rhr: 55, hrvBaseline: baseline(50, 6), sleepPerf: 0.85 }).map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(["HEART_RATE_VARIABILITY", "SLEEP_QUALITY"]));
    expect(labels).not.toContain("RESTING_HEART_RATE");
    expect(labels).not.toContain("RESPIRATORY_RATE");
    expect(labels).not.toContain("SKIN_TEMPERATURE");
  });

  it("delta sign tracks direction", () => {
    const d = chargeDrivers({ hrv: 80, rhr: 70, hrvBaseline: baseline(50, 6), rhrBaseline: baseline(55, 3) });
    expect(row(d, "HEART_RATE_VARIABILITY")).toMatchObject({ verdict: "ABOVE_BASELINE_SUPPORTING" });
    expect(row(d, "HEART_RATE_VARIABILITY").deltaPoints).toBeGreaterThan(0);
    expect(row(d, "RESTING_HEART_RATE")).toMatchObject({ verdict: "ABOVE_BASELINE_LIMITING" });
    expect(row(d, "RESTING_HEART_RATE").deltaPoints).toBeLessThan(0);
  });

  it("skin temp is a relative deviation, never absolute, and never lifts Charge", () => {
    const skin = row(
      chargeDrivers({ hrv: 50, rhr: 55, hrvBaseline: baseline(50, 6), rhrBaseline: baseline(55, 3), skinTempDev: 0.4 }),
      "SKIN_TEMPERATURE",
    );
    expect(skin).toMatchObject({ unit: "CELSIUS_DEVIATION", value: 0.4, baseline: null });
    expect(skin.deltaPoints).toBeLessThanOrEqual(0);
  });

  it("skin temp and respiration keep their raw measurements", () => {
    for (const dev of [-0.35, 0.35, -0.34, 0.34, -0.36, 0.36, -0.0, 0.0]) {
      const d = chargeDrivers({
        hrv: 46,
        rhr: 58,
        resp: 14,
        hrvBaseline: baseline(51, 6.265),
        rhrBaseline: baseline(58, 5.012, 12),
        respBaseline: baseline(15, 1.8795, 12),
        sleepPerf: 0.9,
        skinTempDev: dev,
      });
      const skin = row(d, "SKIN_TEMPERATURE");
      expect(Object.is(skin.value, dev)).toBe(true);
      expect(skin.deltaPoints).toBeLessThanOrEqual(0);
      expect(row(d, "RESPIRATORY_RATE")).toMatchObject({ value: 14, baseline: 15, unit: "BREATHS_PER_MINUTE" });
    }
  });

  it("cold start yields no rows", () => {
    const cold: BaselineState = { baseline: 50, spread: 5, nValid: 2, nightsSinceUpdate: 0, status: "calibrating" };
    expect(chargeDrivers({ hrv: 60, rhr: 50, hrvBaseline: cold, sleepPerf: 0.9 })).toEqual([]);
    expect(forCharge(60, baseline(50, 6, 20))).toBe("solid");
  });

  it("displayRounded matches the Swift oracle exactly", () => {
    const cases: [number, number, number][] = [
      [0.0, 0, 0.0], [51.4, 0, 51.0], [51.5, 0, 52.0], [50.8, 0, 51.0], [-51.5, 0, -52.0],
      [0.0, 1, 0.0], [8.25, 1, 8.3], [15.25, 1, 15.3], [16.05, 1, 16.1], [15.0, 1, 15.0],
      [20.95, 1, 21.0], [-8.25, 1, -8.3], [-0.35, 1, -0.4],
    ];
    for (const [value, digits, expected] of cases) expect(displayRounded(value, digits)).toBe(expected);
  });
});

describe("RecoverySaturationGuardTest: drivers", () => {
  it("the HRV verdict names saturation but the penalty stays full", () => {
    const hrvBaseline = baseline(50, 6.265);
    const rhrBaseline = baseline(55, 5.0);
    const sat = row(chargeDrivers({ hrv: 41, rhr: 48, hrvBaseline, rhrBaseline }), "HEART_RATE_VARIABILITY");
    expect(sat.verdict).toBe("HRV_SATURATION_LIMITING");
    expect(sat.deltaPoints).toBeLessThan(0);
    const fat = row(chargeDrivers({ hrv: 41, rhr: 62, hrvBaseline, rhrBaseline }), "HEART_RATE_VARIABILITY");
    expect(fat.verdict).toBe("BELOW_BASELINE_LIMITING");
    expect(fat.deltaPoints).toBeLessThan(0);
  });
});

describe("RecoveryRhrBaselineUsableTest: drivers", () => {
  const state = (mean: number, sigma: number, status: BaselineStatus, nValid: number): BaselineState => ({
    baseline: mean,
    spread: sigma / 1.253,
    nValid,
    nightsSinceUpdate: status === "stale" ? 20 : 0,
    status,
  });
  const rows = (rhrBaseline: BaselineState | null) =>
    chargeDrivers({ hrv: 55, rhr: 62, hrvBaseline: state(55, 12, "trusted", 20), rhrBaseline, sleepPerf: 0.85 });

  it("an unusable RHR baseline produces no row, identical to none", () => {
    const synthetic = state(75, 6, "calibrating", 0);
    expect(rows(synthetic).map((r) => r.label)).not.toContain("RESTING_HEART_RATE");
    expect(rows(synthetic).map((r) => r.label)).toContain("HEART_RATE_VARIABILITY");
    expect(rows(state(52, 3, "provisional", 5)).map((r) => r.label)).toContain("RESTING_HEART_RATE");
    expect(rows(synthetic)).toEqual(rows(null));
    expect(rows(state(52, 3, "stale", 20))).toEqual(rows(null));
  });
});

describe("plan scenarios", () => {
  it("driver deltas sum to score − neutral within rounding near baseline", () => {
    const args = {
      hrv: 54,
      rhr: 54,
      resp: 15.3,
      hrvBaseline: baseline(50, 6),
      rhrBaseline: baseline(55, 3),
      respBaseline: baseline(15.5, 1),
      sleepPerf: 0.9,
      skinTempDev: 0.2,
    };
    const d = chargeDrivers(args);
    const sum = d.reduce((s, r) => s + r.deltaPoints, 0);
    const total = recoveryFromStates(args)! - logisticScore(0);
    // Each row is rounded to an integer (±0.5); the logistic is not additive, so this holds only near baseline.
    expect(Math.abs(sum - total)).toBeLessThanOrEqual(0.5 * d.length);
  });
});

describe("short-history z shrink in the driver rows", () => {
  // HRV 0.55 σ low and RHR 0.55 σ low: just past the 0.5 saturation entry on raw z, under it once shrunk.
  const hrv = 50 - 0.55 * 10;
  const rhr = 55 - 0.55 * 4;
  const verdict = (nValid: number) =>
    row(chargeDrivers({ hrv, rhr, hrvBaseline: baseline(50, 10, nValid), rhrBaseline: baseline(55, 4, nValid) }), "HEART_RATE_VARIABILITY")
      .verdict;

  it("saturation is detected on the shrunk z, so a marginal signature on a young baseline does not fire", () => {
    expect(verdict(100_000)).toBe("HRV_SATURATION_LIMITING");
    expect(verdict(14)).toBe("BELOW_BASELINE_LIMITING"); // 0.55 × 14/16 = 0.48 < 0.5
  });

  it("driver points shrink with the score: the same HRV dip costs fewer points on a young baseline", () => {
    const points = (nValid: number) =>
      row(chargeDrivers({ hrv: 35, rhr: 55, hrvBaseline: baseline(50, 10, nValid), rhrBaseline: baseline(55, 4, nValid) }), "HEART_RATE_VARIABILITY")
        .deltaPoints;
    expect(points(7)).toBeLessThan(0);
    expect(Math.abs(points(7))).toBeLessThan(Math.abs(points(120)));
  });
});

describe("sleep driver row against your usual night (SCORING_VERSION 17)", () => {
  const args = (sleepPerf: number, sleepCentre?: number) => ({ hrv: 50, rhr: 55, hrvBaseline: baseline(50, 10), rhrBaseline: baseline(55, 4), sleepPerf, sleepCentre });
  const sleepRow = (sleepPerf: number, sleepCentre?: number) => row(chargeDrivers(args(sleepPerf, sleepCentre)), "SLEEP_QUALITY");

  it("is 0 points and a typical night at your centre, with your centre as its baseline", () => {
    expect(sleepRow(0.91, 0.91)).toMatchObject({ deltaPoints: 0, baseline: 91, verdict: "TYPICAL_NIGHT" });
  });

  it("above your centre supports, below it limits, even when both sit above the old fixed 85", () => {
    expect(sleepRow(0.95, 0.91).verdict).toBe("STRONG_NIGHT_SUPPORTING");
    expect(sleepRow(0.88, 0.91)).toMatchObject({ verdict: "BELOW_GOOD_NIGHT_LIMITING" });
    expect(sleepRow(0.88, 0.91).deltaPoints).toBeLessThanOrEqual(0);
  });

  it("without a centre it keeps noop's fixed 85", () => {
    expect(sleepRow(0.85)).toMatchObject({ deltaPoints: 0, baseline: 85 });
  });
});
