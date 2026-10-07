import { describe, expect, it } from "vitest";
import { foldHistory, hrvCfg, zSpread } from "./baselines";
import { personalizedNeedHours, rest } from "./sleep";
import {
  band,
  bandRedMax,
  driverBaseline,
  gatedRecovery,
  logisticK,
  logisticZ0,
  minSleepCentreNights,
  personalSleepCentre,
  sleepCentreWindow,
  sleepPerfScale,
  minBaselineNights,
  parasympatheticSaturation,
  recovery,
  recoveryFromStates,
  satEnterZ,
  satMaxDampFraction,
  skinTempDevScale,
  sleepPerfCenter,
  wHRV,
  wResp,
  wRHR,
  wSkinTemp,
  wSleep,
  watchRecovery,
  zScore,
} from "./recovery";
import type { BaselineState, BaselineStatus } from "./types";

/** A baseline with a given mean and Gaussian σ (spread is abs-dev units). */
const baseline = (mean: number, sigma: number, nValid = 14): BaselineState => ({
  baseline: mean,
  spread: sigma / 1.253,
  nValid,
  nightsSinceUpdate: 0,
  status: nValid >= 14 ? "trusted" : "provisional",
});

describe("ChargeEffortRestScoringTest: Charge", () => {
  it("weight constants", () => {
    expect([wHRV, wRHR, wSleep, wResp, wSkinTemp, skinTempDevScale]).toEqual([0.55, 0.2, 0.15, 0.05, 0.05, 1.0]);
  });

  const hrvBase = { mean: 60, spread: 8 };
  const rhrBase = { mean: 55, spread: 4 };
  const chargeAt = (skinTempDev: number | null) =>
    recovery({ hrv: 60, rhr: 55, hrvBaseline: hrvBase, rhrBaseline: rhrBase, sleepPerf: sleepPerfCenter, skinTempDev })!;

  it("null skin temp is identical to a zero deviation at composite z 0", () => {
    expect(chargeAt(0)).toBeCloseTo(chargeAt(null), 9);
  });
  it("skin-temp deviation lowers Charge, symmetrically", () => {
    expect(chargeAt(1)).toBeLessThan(chargeAt(null));
    expect(chargeAt(1)).toBeCloseTo(chargeAt(-1), 9);
  });
  it("the cold-start gate is unaffected by skin temp", () => {
    const score = recovery({
      hrv: 60,
      rhr: 55,
      hrvBaseline: hrvBase,
      rhrBaseline: rhrBase,
      sleepPerf: 0.85,
      skinTempDev: 0.7,
      hrvBaselineUsable: false,
    });
    expect(score).toBeNull();
  });
});

describe("RecoveryRequiredHrvBaselineTest", () => {
  const rhrB = { mean: 55, spread: 3 / 1.253 };
  const respB = { mean: 14.5, spread: 1 / 1.253 };
  const effortB = { mean: 40, spread: 15 / 1.253 };
  const base = { hrv: 50, rhr: 60, hrvBaseline: null };

  it("refuses to score without the HRV baseline, whatever else is present", () => {
    expect(recovery({ ...base, sleepPerf: 0.85 })).toBeNull();
    expect(recovery({ ...base, rhrBaseline: rhrB })).toBeNull();
    expect(recovery({ ...base, resp: 14, respBaseline: respB })).toBeNull();
    expect(recovery({ ...base, skinTempDev: 0.4 })).toBeNull();
    expect(recovery({ ...base, recoveryIndexSlope: -1 })).toBeNull();
    expect(recovery({ ...base, effortBaseline: effortB, priorDayEffort: 80 })).toBeNull();
    expect(
      recovery({
        ...base,
        resp: 14,
        rhrBaseline: rhrB,
        respBaseline: respB,
        sleepPerf: 0.85,
        skinTempDev: 0.4,
        recoveryIndexSlope: -1,
        effortBaseline: effortB,
        priorDayEffort: 80,
      }),
    ).toBeNull();
  });

  it("preserves cold start and the Swift-oracle score", () => {
    const hrvB = { mean: 50, spread: 6 / 1.253 };
    expect(recovery({ hrv: 50, rhr: 60, hrvBaseline: hrvB, sleepPerf: 0.85, hrvBaselineUsable: false })).toBeNull();
    expect(recovery({ hrv: 50, rhr: 60, hrvBaseline: hrvB, sleepPerf: 0.85 })).toBeCloseTo(57.932425214874954, 12);
  });
});

describe("RecoverySaturationGuardTest", () => {
  const undamped = (hrv: number, rhr: number, hrvB: BaselineState, rhrB: BaselineState) => {
    // The raw composite: z against each baseline's z-score spread (shrink included), no saturation easing.
    const z = (wHRV * zScore(hrv, hrvB.baseline, zSpread(hrvB)) + wRHR * zScore(rhrB.baseline, rhr, zSpread(rhrB))) / (wHRV + wRHR);
    return 100 / (1 + Math.exp(-logisticK * (z - logisticZ0)));
  };
  const hrvB = baseline(50, 6.265);
  const rhrB = baseline(55, 5.0);
  const score = (hrv: number, rhr: number) => recoveryFromStates({ hrv, rhr, hrvBaseline: hrvB, rhrBaseline: rhrB })!;

  it("fires on the saturation signature and would ease but never remove the penalty", () => {
    const s = parasympatheticSaturation(-1.5, 1.5);
    expect(s.active).toBe(true);
    expect(s.easedHrvZ).toBeGreaterThan(-1.5);
    expect(s.easedHrvZ).toBeLessThan(0);
    expect(s.dampFraction).toBeGreaterThan(0);
    expect(s.dampFraction).toBeLessThanOrEqual(satMaxDampFraction);
  });

  it("is silent on real fatigue, non-low HRV, no RHR signal, and marginal divergence", () => {
    expect(parasympatheticSaturation(-1.5, -1.5)).toEqual({ easedHrvZ: -1.5, active: false, dampFraction: 0 });
    expect(parasympatheticSaturation(1.5, 1.5).active).toBe(false);
    expect(parasympatheticSaturation(0, 1.5).active).toBe(false);
    expect(parasympatheticSaturation(-1.5, null)).toEqual({ easedHrvZ: -1.5, active: false, dampFraction: 0 });
    const below = satEnterZ - 0.05;
    expect(parasympatheticSaturation(-below, below)).toEqual({ easedHrvZ: -below, active: false, dampFraction: 0 });
  });

  it("damping is monotonic in corroboration and capped by the weaker arm", () => {
    const weak = parasympatheticSaturation(-0.8, 0.8).dampFraction;
    const strong = parasympatheticSaturation(-1.4, 1.4).dampFraction;
    expect(strong).toBeGreaterThan(weak);
    expect(parasympatheticSaturation(-3, 3).dampFraction).toBeCloseTo(satMaxDampFraction, 12);
    expect(parasympatheticSaturation(-3, 0.8).dampFraction).toBeLessThan(parasympatheticSaturation(-3, 3).dampFraction);
  });

  it("a firing night still scores the raw composite and stays red", () => {
    const sat = parasympatheticSaturation(zScore(40, hrvB.baseline, zSpread(hrvB)), zScore(rhrB.baseline, 47, zSpread(rhrB)));
    expect(sat.active).toBe(true);
    expect(sat.dampFraction).toBeGreaterThan(0.4);
    expect(score(40, 47)).toBeCloseTo(undamped(40, 47, hrvB, rhrB), 9);
    expect(score(40, 47)).toBeLessThan(bandRedMax);
  });

  it("fatigue and good nights are unchanged too", () => {
    expect(score(41, 62)).toBeLessThan(bandRedMax);
    expect(score(41, 62)).toBeCloseTo(undamped(41, 62, hrvB, rhrB), 9);
    expect(score(62, 49)).toBeCloseTo(undamped(62, 49, hrvB, rhrB), 9);
  });
});

describe("RecoveryRhrBaselineUsableTest", () => {
  const state = (mean: number, sigma: number, status: BaselineStatus, nValid: number): BaselineState => ({
    baseline: mean,
    spread: sigma / 1.253,
    nValid,
    nightsSinceUpdate: status === "stale" ? 20 : 0,
    status,
  });
  const hrvBase = state(55, 12, "trusted", 20);
  const score = (rhrBaseline: BaselineState | null) =>
    recoveryFromStates({ hrv: 55, rhr: 62, hrvBaseline: hrvBase, rhrBaseline, sleepPerf: 0.85 })!;

  it("synthetic and stale RHR baselines score like an absent one; a usable one contributes", () => {
    expect(score(state(75, 6, "calibrating", 0))).toBeCloseTo(score(null), 12);
    expect(score(state(52, 3, "stale", 20))).toBeCloseTo(score(null), 12);
    expect(Math.abs(score(state(52, 3, "provisional", 5)) - score(null))).toBeGreaterThan(1e-9);
  });
});

describe("RecoveryIndexActivityBalanceTest", () => {
  const args = { hrv: 50, rhr: 55, hrvBaseline: baseline(50, 6), rhrBaseline: baseline(55, 3), sleepPerf: sleepPerfCenter };

  it("omitted optional terms equal explicit nulls", () => {
    const a = { hrv: 55, rhr: 52, resp: 14, hrvBaseline: baseline(50, 6), rhrBaseline: baseline(55, 3), respBaseline: baseline(14.5, 1), sleepPerf: 0.9, skinTempDev: 0.4 };
    expect(recoveryFromStates({ ...a, recoveryIndexSlope: null, effortBaseline: null, priorDayEffort: null })).toBe(
      recoveryFromStates(a),
    );
  });

  it("a steeper overnight decline raises Charge more than flat or rising", () => {
    const s = (recoveryIndexSlope: number) => recoveryFromStates({ ...args, recoveryIndexSlope })!;
    expect(s(-4)).toBeGreaterThan(s(-1));
    expect(s(-1)).toBeGreaterThan(s(0));
    expect(s(0)).toBeGreaterThan(s(2));
  });

  it("activity balance: harder yesterday lowers Charge, and needs both value and baseline", () => {
    const s = (priorDayEffort: number | null, effortBaseline: BaselineState | null = baseline(40, 15)) =>
      recoveryFromStates({ hrv: 58, rhr: 50, hrvBaseline: baseline(50, 6), rhrBaseline: baseline(55, 3), sleepPerf: 0.92, effortBaseline, priorDayEffort })!;
    expect(s(40)).toBeLessThan(s(null));
    expect(s(10)).toBeGreaterThan(s(40));
    expect(s(40)).toBeGreaterThan(s(65));
    expect(s(65)).toBeGreaterThan(s(90));
    const t = (priorDayEffort: number | null, effortBaseline: BaselineState | null) =>
      recoveryFromStates({ ...args, effortBaseline, priorDayEffort })!;
    expect(t(80, null)).toBeCloseTo(t(null, null), 9);
    expect(t(null, baseline(40, 15))).toBeCloseTo(t(null, null), 9);
    expect(t(80, baseline(40, 15))).not.toBeCloseTo(t(null, null), 9);
  });
});

describe("WatchRecoveryTest", () => {
  const hist = Array<number>(14).fill(45);
  const rhrHist = Array<number>(14).fill(52);

  it("at baseline gives mid recovery, solid", () => {
    const out = watchRecovery(45, 52, hist, rhrHist);
    expect(out.recovery).toBeGreaterThanOrEqual(40);
    expect(out.recovery).toBeLessThanOrEqual(60);
    expect(out.confidence).toBe("solid");
  });
  it("high HRV with low RHR is high; low HRV with high RHR is low", () => {
    expect(watchRecovery(70, 46, hist, rhrHist).recovery).toBeGreaterThan(65);
    expect(watchRecovery(22, 62, hist, rhrHist).recovery).toBeLessThan(40);
  });
  it("insufficient history or missing HRV calibrates", () => {
    expect(watchRecovery(45, 52, [45, 46], [52, 51])).toEqual({ recovery: null, confidence: "calibrating" });
    expect(watchRecovery(null, 52, hist, hist)).toEqual({ recovery: null, confidence: "calibrating" });
  });
  it("the week gate counts accepted nights, not raw entries", () => {
    expect(watchRecovery(45, null, [45, 46, 47, 48, -1, 0, 999], []).recovery).toBeNull();
    expect(watchRecovery(45, null, [45, 46, 47, -1, 0, 999, 1000], []).recovery).toBeNull();
    expect(watchRecovery(45, null, [45, 46, 47, 48, 45, 46], []).recovery).toBeNull();
    const ok = watchRecovery(45, null, [45, 46, 47, 48, 45, 46, 47, -1, 999], []);
    expect(ok.recovery).not.toBeNull();
    expect(ok.confidence).not.toBe("calibrating");
  });
  it("an empty or junk RHR history scores like missing RHR (Swift oracle)", () => {
    const h7 = Array<number>(7).fill(45);
    const withRhr = watchRecovery(45, 52, h7, []).recovery!;
    expect(withRhr).toBeCloseTo(watchRecovery(45, null, h7, []).recovery!, 12);
    expect(withRhr).toBeCloseTo(57.932425214874954, 12);
    const junk = Array<number>(7).fill(300);
    expect(watchRecovery(45, 52, h7, junk).recovery!).toBeCloseTo(watchRecovery(45, null, h7, junk).recovery!, 12);
  });
  it("a usable RHR history still contributes", () => {
    const h7 = Array<number>(7).fill(45);
    const rhr4 = Array<number>(4).fill(52);
    expect(watchRecovery(45, 62, h7, rhr4).recovery!).toBeLessThan(watchRecovery(45, null, h7, rhr4).recovery! - 1);
  });
});

describe("plan scenarios", () => {
  it("band boundaries", () => {
    expect(band(66.9)).toBe("yellow");
    expect(band(67)).toBe("green");
    expect(band(33.9)).toBe("red");
    expect(band(34)).toBe("yellow");
  });

  it("an unusable or missing HRV baseline returns null", () => {
    const cold = foldHistory([50, 50, 50], hrvCfg);
    expect(recoveryFromStates({ hrv: 50, rhr: 55, hrvBaseline: cold })).toBeNull();
    expect(recovery({ hrv: 50, rhr: 55, hrvBaseline: null })).toBeNull();
  });

  it("fewer than 7 accepted prior nights is null with calibrating; 7 scores", () => {
    expect(minBaselineNights).toBe(7);
    const six = foldHistory(Array(6).fill(50), hrvCfg);
    expect(gatedRecovery({ hrv: 50, rhr: null, hrvBaseline: six })).toEqual({ recovery: null, confidence: "calibrating" });
    const seven = foldHistory(Array(7).fill(50), hrvCfg);
    expect(gatedRecovery({ hrv: 50, rhr: null, hrvBaseline: seven })).toMatchObject({ confidence: "building" });
    expect(gatedRecovery({ hrv: null, rhr: 55, hrvBaseline: seven })).toEqual({ recovery: null, confidence: "calibrating" });
  });

  it("skin-temp null equals the no-skin-temp model; ±0.5 °C gives the same penalty", () => {
    const a = { hrv: 58, rhr: 53, resp: 15, hrvBaseline: baseline(50, 6), rhrBaseline: baseline(55, 3), respBaseline: baseline(15.5, 1), sleepPerf: 0.8 };
    const noSkin = recoveryFromStates(a)!;
    expect(recoveryFromStates({ ...a, skinTempDev: null })).toBe(noSkin);
    const warm = recoveryFromStates({ ...a, skinTempDev: 0.5 })!;
    expect(warm).toBe(recoveryFromStates({ ...a, skinTempDev: -0.5 }));
    expect(warm).toBeLessThan(noSkin);
  });

  it("gatedRecovery uses every supplied term", () => {
    const hrvBaseline = baseline(50, 6);
    const terms = { hrv: 58, rhr: 53, resp: 15, rhrBaseline: baseline(55, 3), respBaseline: baseline(15.5, 1), sleepPerf: 0.8, skinTempDev: 0.2 };
    expect(gatedRecovery({ ...terms, hrvBaseline }).recovery).toBe(recoveryFromStates({ ...terms, hrvBaseline }));
    expect(gatedRecovery({ ...terms, hrvBaseline }).confidence).toBe("solid");
  });
});

describe("short-history z shrink in Recovery", () => {
  it("driverBaseline hands Recovery the shrunk spread: spread × (n + 2) / n", () => {
    const b = baseline(50, 10, 7);
    expect(driverBaseline(b)).toEqual({ mean: 50, spread: zSpread(b) });
    expect(driverBaseline(b).spread).toBeCloseTo((b.spread * 9) / 7, 12);
  });

  it("recoveryFromStates scores every z term against the shrunk spread", () => {
    const hrvBaseline = baseline(50, 10, 7);
    const rhrBaseline = baseline(55, 4, 9);
    const respBaseline = baseline(15, 1, 20);
    const args = { hrv: 42, rhr: 58, resp: 16, sleepPerf: 0.8 };
    const manual = recovery({
      ...args,
      hrvBaseline: { mean: 50, spread: (hrvBaseline.spread * 9) / 7 },
      rhrBaseline: { mean: 55, spread: (rhrBaseline.spread * 11) / 9 },
      respBaseline: { mean: 15, spread: (respBaseline.spread * 22) / 20 },
    });
    expect(recoveryFromStates({ ...args, hrvBaseline, rhrBaseline, respBaseline })).toBeCloseTo(manual!, 12);
  });

  it("the same night against the same σ reads less extreme on a young baseline", () => {
    // Neutral = HRV and RHR exactly at baseline; a young baseline pulls the score towards it.
    const score = (hrv: number, rhr: number, nValid: number) =>
      recoveryFromStates({ hrv, rhr, hrvBaseline: baseline(50, 10, nValid), rhrBaseline: baseline(55, 4, nValid) })!;
    const neutral = (n: number) => score(50, 55, n);
    for (const [hrv, rhr] of [
      [35, 60],
      [65, 50],
    ]) {
      const young = Math.abs(score(hrv, rhr, 7) - neutral(7));
      const mid = Math.abs(score(hrv, rhr, 14) - neutral(14));
      const old = Math.abs(score(hrv, rhr, 120) - neutral(120));
      expect(young).toBeLessThan(mid);
      expect(mid).toBeLessThan(old);
    }
    // At the baseline itself the shrink changes nothing.
    expect(neutral(7)).toBeCloseTo(neutral(120), 12);
  });

  it("the HRV term's z is exactly the raw z × n / (n + 2)", () => {
    // Only the HRV term: Recovery = logistic(z), so invert it to read back the z that was used.
    const b = baseline(50, 10, 7);
    const r = recoveryFromStates({ hrv: 40, rhr: null, hrvBaseline: b })!;
    const z = logisticZ0 - Math.log(100 / r - 1) / logisticK;
    expect(z).toBeCloseTo((-10 / 10) * (7 / 9), 9);
  });
});

describe("sleep term centred on your own usual night (SCORING_VERSION 17)", () => {
  const atBaseline = { hrv: 60, hrvBaseline: { mean: 60, spread: 8 }, rhr: 55, rhrBaseline: { mean: 55, spread: 2.5 } };
  const R = (sleepPerf: number | null, sleepCentre?: number) => recovery({ ...atBaseline, sleepPerf, sleepCentre })!;

  it("personalSleepCentre: 0.85 under 7 nights, else the mean of the last 28", () => {
    expect(minSleepCentreNights).toBe(7);
    expect(sleepCentreWindow).toBe(28);
    expect(personalSleepCentre([])).toBe(sleepPerfCenter);
    expect(personalSleepCentre(Array(6).fill(0.95))).toBe(sleepPerfCenter);
    expect(personalSleepCentre(Array(7).fill(0.95))).toBeCloseTo(0.95, 12);
    // Older values than the last 28 are ignored.
    expect(personalSleepCentre([...Array(10).fill(0.5), ...Array(28).fill(0.9)])).toBeCloseTo(0.9, 12);
    expect(personalSleepCentre([0.8, 0.9, 0.85, 0.95, 0.75, 0.9, 0.85])).toBeCloseTo(6 / 7, 12);
  });

  it("a centre shifts the term exactly like shifting last night's score; none keeps noop's 0.85", () => {
    expect(R(0.92, 0.9)).toBeCloseTo(R(0.87), 12);
    expect(R(0.9)).toBeCloseTo(R(0.9, sleepPerfCenter), 12);
    expect(R(0.9, 0.9)).toBeCloseTo(R(sleepPerfCenter), 12); // your usual night is neutral
    expect(R(null, 0.7)).toBeCloseTo(R(null), 12);
  });

  describe("simulated sleepers (the real sleep score, v15 need)", () => {
    const sleepers = [
      { name: "good", h: 7.5, eff: 0.92, deep: 0.16, rem: 0.22, sri: 85 },
      { name: "typical", h: 7.0, eff: 0.88, deep: 0.14, rem: 0.21, sri: 78 },
      { name: "older adult", h: 7.0, eff: 0.85, deep: 0.08, rem: 0.18, sri: 80 },
      { name: "restless", h: 6.5, eff: 0.8, deep: 0.12, rem: 0.18, sri: 70 },
    ];
    /** 60 ordinary nights' sleep scores (0–1), then one bad night (5 h at 75 % efficiency). */
    const nights = (p: (typeof sleepers)[number]) => {
      let x = 5;
      const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648), x / 2147483648);
      const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
      const hours: number[] = [];
      return Array.from({ length: 61 }, (_, d) => {
        const bad = d === 60;
        const h = bad ? 5 : Math.max(4, p.h + 0.5 * g());
        const eff = bad ? 0.75 : Math.min(0.98, p.eff + 0.03 * g());
        const need = personalizedNeedHours(hours.slice(-28), 40);
        hours.push(h);
        return rest(h * 3600, eff, Math.max(0, p.deep + 0.02 * g()) * h * 3600, Math.max(0, p.rem + 0.03 * g()) * h * 3600, need, p.sri / 100)! / 100;
      });
    };
    const neutral = R(sleepPerfCenter);
    const stats = (perf: number[], centreAt: (i: number) => number) => {
      const off = perf.slice(30, 60).map((v, k) => R(v, centreAt(30 + k)) - neutral);
      const mean = off.reduce((a, b) => a + b, 0) / off.length;
      const swing = Math.sqrt(off.reduce((a, v) => a + (v - mean) ** 2, 0) / off.length);
      return { mean, swing, bad: R(perf[60], centreAt(60)) - neutral };
    };

    for (const p of sleepers) {
      it(`${p.name}: no permanent offset with your own centre (the fixed 0.85 gave ≥ 1 point), same swing, a bad night still counts`, () => {
        const perf = nights(p);
        const fixed = stats(perf, () => sleepPerfCenter);
        const own = stats(perf, (i) => personalSleepCentre(perf.slice(0, i)));
        // Fixed 0.85: good +2.7, typical +1.0, older adult −2.1, restless −3.0 points every day.
        expect(Math.abs(fixed.mean)).toBeGreaterThanOrEqual(1);
        expect(Math.abs(own.mean)).toBeLessThanOrEqual(0.8);
        expect(Math.abs(own.swing - fixed.swing)).toBeLessThanOrEqual(0.2);
        expect(own.bad).toBeLessThanOrEqual(-4);
        expect(own.bad).toBeGreaterThanOrEqual(-12);
      });
    }

    it("the rejected design (z against your own sleep spread) would swing ordinary nights by over 4 points", () => {
      const perf = nights(sleepers[1]);
      const z = (i: number) => {
        const prior = perf.slice(Math.max(0, i - 28), i);
        const m = prior.reduce((a, b) => a + b, 0) / prior.length;
        const sd = Math.sqrt(prior.reduce((a, v) => a + (v - m) ** 2, 0) / prior.length);
        return (perf[i] - m) / Math.max(sd, 0.015);
      };
      // Feed the personal z through the same term: sleepPerf = 0.85 + z × 0.12.
      const off = perf.slice(30, 60).map((_, k) => R(sleepPerfCenter + z(30 + k) * sleepPerfScale) - neutral);
      const mean = off.reduce((a, b) => a + b, 0) / off.length;
      expect(Math.sqrt(off.reduce((a, v) => a + (v - mean) ** 2, 0) / off.length)).toBeGreaterThan(4);
    });
  });
});
