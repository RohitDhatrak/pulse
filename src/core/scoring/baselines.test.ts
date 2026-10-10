import { describe, expect, it } from "vitest";
import {
  cutoffKey,
  deviation,
  earlyHalfLifeB,
  floorOf,
  foldHistory,
  freshestCarried,
  hrvCfg,
  type HoldState,
  illnessHold,
  illnessWardZ,
  isoEpochDay,
  isTrusted,
  isUsable,
  lambda,
  metricCfg,
  nextHold,
  nightsSinceNewestValidNight,
  noHold,
  recentHrvCoverage,
  respCfg,
  restartAfterRejections,
  restingHRCfg,
  rollingMeanSD,
  sigma,
  update,
  zShrinkK,
  zSigma,
  zSpread,
} from "./baselines";
import { recoveryFromStates } from "./recovery";
import type { BaselineState, MetricCfg } from "./types";

const repeat = (v: number | null, n: number) => Array.from({ length: n }, () => v);

describe("plan scenarios", () => {
  it("3 nights unusable, 4 usable, 14 trusted", () => {
    expect(foldHistory(repeat(50, 3), hrvCfg).status).toBe("calibrating");
    expect(isUsable(foldHistory(repeat(50, 3), hrvCfg))).toBe(false);
    expect(foldHistory(repeat(50, 4), hrvCfg).status).toBe("provisional");
    expect(isUsable(foldHistory(repeat(50, 4), hrvCfg))).toBe(true);
    expect(foldHistory(repeat(50, 13), hrvCfg).status).toBe("provisional");
    expect(isTrusted(foldHistory(repeat(50, 14), hrvCfg))).toBe(true);
  });

  it("young regime (version 32): an early outlier is trimmed, not folded; the rest is the kept values' mean", () => {
    const young = foldHistory(repeat(50, 4), hrvCfg); // baseline 50, spread at the 5 ms floor
    expect(young).toMatchObject({ baseline: 50, spread: 5, nValid: 4 });
    // 80: the median is 50 and the MAD is floored at 2.5, so anything beyond 4 × 1.4826 × 2.5 = 14.8 is trimmed.
    const s = update(young, 80, hrvCfg);
    expect(s).toMatchObject({ nValid: 5, baseline: 50, spread: 5, early: [50, 50, 50, 50, 80] });
    // Version 31's young regime (the re-fold mode keeps it) folded it at the fast centre half-life.
    const lb = 1 - 0.5 ** (1 / earlyHalfLifeB);
    expect(update(young, 80, hrvCfg, false).baseline).toBeCloseTo(50 + 30 * lb, 12);
    expect(update(young, 100, hrvCfg, false).baseline).toBeCloseTo(50 + 37.5 * lb, 12); // ±3 × 2.5 × spread clamp
  });

  it("after 8 nights a value 6× spread away is rejected and leaves the baseline unchanged", () => {
    const settled = foldHistory(repeat(50, 8), hrvCfg);
    const s = update(settled, 80, hrvCfg);
    // Since version 33 it also starts a run of rejections (7 in a row restart the baseline).
    expect(s).toEqual({ ...settled, nightsSinceUpdate: 0, rejected: { side: 1, values: [80] } });
    // The window-fold mode (Readiness) folds it instead, clamped at ±3 × spread.
    const lb = lambda(hrvCfg.halfLifeB);
    expect(update(settled, 80, hrvCfg, false).baseline).toBeCloseTo(lb * 65 + (1 - lb) * 50, 12);
  });

  it("stale after more than 14 missing nights; back to trusted when data resumes", () => {
    const trusted = foldHistory(repeat(50, 14), hrvCfg);
    expect(foldHistory([...repeat(50, 14), ...repeat(null, 14)], hrvCfg).status).toBe("trusted");
    let s = foldHistory([...repeat(50, 14), ...repeat(null, 15)], hrvCfg);
    expect(s.status).toBe("stale");
    expect(isUsable(s)).toBe(false);
    s = update(s, 50, hrvCfg);
    expect(s.status).toBe("trusted");
    expect(s.nValid).toBe(trusted.nValid + 1);
  });

  it("stale with fewer than 14 valid nights returns to provisional", () => {
    const s = foldHistory([...repeat(50, 5), ...repeat(null, 15)], hrvCfg);
    expect(s.status).toBe("stale");
    expect(update(s, 50, hrvCfg).status).toBe("provisional");
  });

  it("out-of-range values skip and hold; the empty history is the config midpoint", () => {
    const s = foldHistory([45, -1, 0, 999], hrvCfg);
    expect(s).toMatchObject({ baseline: 45, nValid: 1, nightsSinceUpdate: 3 });
    expect(foldHistory([], restingHRCfg)).toEqual({
      baseline: 75,
      spread: 1.5, // version 36: the 1 bpm floor, 1.5× while young
      nValid: 0,
      nightsSinceUpdate: 0,
      status: "calibrating",
    });
  });
});

describe("early spread", () => {
  // Deterministic LCG + Box–Muller, so the Monte Carlo is the same on every run.
  const gaussian = (seed: number) => {
    let x = seed;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648), x / 2147483648);
    return () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
  };
  type Case = { cfg: MetricCfg; mu: number; sd: number };
  const hrv10: Case = { cfg: hrvCfg, mu: 50, sd: 10 };
  const hrv15: Case = { cfg: hrvCfg, mu: 70, sd: 15 };
  const rhr4: Case = { cfg: restingHRCfg, mu: 55, sd: 4 };
  /** Mean σ over `runs` simulated users, and sd of the next night's z (raw σ and the shrunk zSigma). */
  const simulate = ({ cfg, mu, sd }: Case, n: number, runs = 400) => {
    const norm = gaussian(42);
    let sig = 0;
    let zRaw = 0;
    let zShrunk = 0;
    for (let r = 0; r < runs; r++) {
      const s = foldHistory(Array.from({ length: n }, () => mu + sd * norm()), cfg);
      const next = mu + sd * norm();
      sig += sigma(s);
      zRaw += ((next - s.baseline) / sigma(s)) ** 2;
      zShrunk += ((next - s.baseline) / zSigma(s)) ** 2;
    }
    return { sigma: sig / runs, sdZ: Math.sqrt(zRaw / runs), sdZShrunk: Math.sqrt(zShrunk / runs) };
  };
  const ls21 = lambda(hrvCfg.halfLifeS);

  it("learns a true HRV wobble of 10 ms by night 7, not the 5 ms floor", () => {
    // The fix list's golden case: σ after 7 nights in [8.5, 11.5]. Before the fix it was about 7.0.
    const s7 = simulate(hrv10, 7).sigma;
    expect(s7).toBeGreaterThanOrEqual(8.5);
    expect(s7).toBeLessThanOrEqual(11.5);
  });

  const cases: [string, Case][] = [
    ["HRV 10 ms", hrv10],
    ["HRV 15 ms", hrv15],
    ["RHR 4 bpm", rhr4],
  ];
  for (const [name, c] of cases) {
    it(`${name}: σ is within 10 % of the truth at 7, 14, 30 and 60 nights`, () => {
      for (const n of [7, 14, 30, 60]) expect(Math.abs(simulate(c, n).sigma / c.sd - 1), `n=${n}`).toBeLessThan(0.1);
    });

    it(`${name}: with the shrink the next night's z has sd ≈ 1 from night 7 (calibrated, not jumpy)`, () => {
      for (const n of [7, 14, 30]) {
        const { sdZ, sdZShrunk } = simulate(c, n);
        expect(sdZShrunk, `n=${n}`).toBeGreaterThan(0.85);
        // Version 32's robust first week estimates σ from the 7 values themselves, a little noisier at night 7 for a
        // large wobble (1.11 for HRV 15 ms); within 1.1 from night 14.
        expect(sdZShrunk, `n=${n}`).toBeLessThan(n === 7 ? 1.15 : 1.1);
        expect(sdZShrunk, `n=${n}`).toBeLessThan(sdZ);
      }
    });
  }

  it("a wobble under the floor still sits on the floor (version 36: 5 % of HRV, 1 bpm; 2× and 1.5× while young)", () => {
    // HRV 50 ± 1: 2.5 ms settled, 5 ms in the first fortnight. Resting HR 55 ± 0.5: 1 bpm settled.
    expect(simulate({ cfg: hrvCfg, mu: 50, sd: 1 }, 7).sigma).toBeCloseTo(1.253 * 5, 1);
    expect(simulate({ cfg: hrvCfg, mu: 50, sd: 1 }, 60).sigma).toBeCloseTo(1.253 * 2.5, 1);
    expect(simulate({ cfg: restingHRCfg, mu: 55, sd: 0.5 }, 60).sigma).toBeCloseTo(1.253 * restingHRCfg.floorSpread, 1);
  });

  it("the floor seed drops out on night 2: the spread comes from the two values alone", () => {
    // Version 32: centre 60, mean deviation 10, × √(2 / 1) for a sample this small.
    const s = foldHistory([50, 70], hrvCfg);
    expect(s.baseline).toBe(60);
    expect(s.spread).toBeCloseTo(10 * Math.SQRT2, 12);
  });

  it("over the first nights the centre is the kept values' mean and the spread their mean deviation, small-sample corrected", () => {
    // 50, 70, 40, 60: median 55, MAD 10, nothing trimmed. Centre 55; deviations 5, 15, 15, 5 → 10 × √(4 / 3).
    const s = foldHistory([50, 70, 40, 60], hrvCfg);
    expect(s.baseline).toBe(55);
    expect(s.spread).toBeCloseTo(10 * Math.sqrt(4 / 3), 12);
  });

  it("the floor still binds on each night of the running mean", () => {
    // Deviations of 0.5 ms average to well under the young floor at 50 ms: 2 × 5 % × the centre (version 36).
    const s = foldHistory([50, 51, 50, 51, 50], hrvCfg);
    expect(s.spread).toBeCloseTo(2 * 0.05 * s.baseline, 12);
    expect(floorOf(hrvCfg, s.baseline, s.nValid)).toBe(s.spread);
  });

  it("the HRV floor scales with the centre (version 36); resting HR's is absolute", () => {
    expect(floorOf(hrvCfg, 25, 30)).toBeCloseTo(1.25, 12);
    expect(floorOf(hrvCfg, 25, 13)).toBeCloseTo(2.5, 12); // young: 2×
    expect(floorOf(hrvCfg, 100, 30)).toBeCloseTo(5, 12); // the old fixed floor, reached at 100 ms
    expect(floorOf(hrvCfg, 10, 30)).toBe(1); // never under 1 ms
    expect(floorOf(restingHRCfg, 50, 30)).toBe(1);
    expect(floorOf(restingHRCfg, 50, 13)).toBe(1.5);
    expect(floorOf(respCfg, 15, 3)).toBe(0.5); // the other metrics keep their absolute floor, young or not
  });

  it("the floor drops when the baseline is trusted, and the spread follows it down gradually", () => {
    // HRV 25 ± 0.4: the young floor (2.5 ms) binds to night 13; from night 14 the floor is 1.25 and the spread decays
    // towards it at the 1/n running-mean rate rather than jumping.
    const xs = Array.from({ length: 40 }, (_, i) => 25 + (i % 2 ? 0.4 : -0.4));
    const at = (n: number) => foldHistory(xs.slice(0, n), hrvCfg);
    expect(at(13).spread).toBeCloseTo(2.5, 1);
    expect(at(14).spread).toBeLessThan(2.5);
    expect(at(14).spread).toBeGreaterThan(2.3);
    expect(at(40).spread).toBeLessThan(at(20).spread);
    expect(at(40).spread).toBeGreaterThanOrEqual(1.25);
  });

  it("hands over from 1/n to the 21-night EWMA after night 31", () => {
    // 1/30 > λ(21) > 1/31: the long EWMA takes over once 31 nights are in.
    expect(1 / 30).toBeGreaterThan(ls21);
    expect(1 / 31).toBeLessThan(ls21);
    const settled = (nValid: number): BaselineState => ({ baseline: 50, spread: 8, nValid, nightsSinceUpdate: 0, status: "trusted" });
    const lb14 = lambda(hrvCfg.halfLifeB);
    const nb = 50 + lb14 * 10; // 60 is inside ±3 × 8, so it folds unclamped
    const dev = Math.abs(60 - nb);
    expect(update(settled(30), 60, hrvCfg).spread).toBeCloseTo((1 / 30) * dev + (1 - 1 / 30) * 8, 12);
    expect(update(settled(31), 60, hrvCfg).spread).toBeCloseTo(ls21 * dev + (1 - ls21) * 8, 12);
    expect(update(settled(200), 60, hrvCfg).spread).toBeCloseTo(ls21 * dev + (1 - ls21) * 8, 12);
  });

  it("missing and out-of-range nights hold the spread and do not advance the running-mean count", () => {
    const withGaps = foldHistory([50, null, 70, 999, null, 40], hrvCfg);
    const without = foldHistory([50, 70, 40], hrvCfg);
    expect(withGaps.spread).toBe(without.spread);
    expect(withGaps.nValid).toBe(3);
  });

  it("a rejected hard outlier leaves spread and count untouched", () => {
    const settled = foldHistory([50, 52, 48, 51, 49, 50, 53, 47, 50, 51], hrvCfg);
    const s = update(settled, settled.baseline + 6 * settled.spread, hrvCfg);
    expect(s.spread).toBe(settled.spread);
    expect(s.nValid).toBe(settled.nValid);
  });

  it("a constant history keeps the floor and a zero-wobble user is not divided by zero", () => {
    const s = foldHistory(repeat(50, 400), hrvCfg);
    expect(s.spread).toBeCloseTo(floorOf(hrvCfg, 50, 400), 6);
    expect(Number.isFinite(deviation(55, s).z)).toBe(true);
  });
});

describe("z shrink (zSpread / zSigma)", () => {
  const at = (nValid: number, spread = 8): BaselineState => ({ baseline: 50, spread, nValid, nightsSinceUpdate: 0, status: "trusted" });

  it("k is 2", () => {
    expect(zShrinkK).toBe(2);
  });

  it("widens the spread by (n + k) / n, which shrinks z by n / (n + k)", () => {
    for (const n of [4, 7, 14, 30, 60, 365]) {
      expect(zSpread(at(n))).toBeCloseTo((8 * (n + 2)) / n, 12);
      expect(zSigma(at(n))).toBeCloseTo(1.253 * ((8 * (n + 2)) / n), 12);
      expect(zSigma(at(n)) / sigma(at(n))).toBeCloseTo((n + 2) / n, 12);
    }
  });

  it("the documented multipliers: ×0.78 at 7, ×0.88 at 14, ×0.94 at 30, ×0.97 at 60", () => {
    const shrink = (n: number) => sigma(at(n)) / zSigma(at(n));
    expect(shrink(7)).toBeCloseTo(0.78, 2);
    expect(shrink(14)).toBeCloseTo(0.875, 3);
    expect(shrink(30)).toBeCloseTo(0.94, 2);
    expect(shrink(60)).toBeCloseTo(0.97, 2);
  });

  it("fades continuously: strictly less shrink every night, no step at the trusted boundary, → 1", () => {
    let prev = 0;
    for (let n = 1; n <= 400; n++) {
      const f = sigma(at(n)) / zSigma(at(n));
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
    // Night 13 (provisional) to 14 (trusted) moves by the same small amount as any neighbouring nights.
    const step = (n: number) => sigma(at(n + 1)) / zSigma(at(n + 1)) - sigma(at(n)) / zSigma(at(n));
    expect(step(13)).toBeLessThan(0.01);
    expect(step(13)).toBeLessThan(step(12));
    expect(sigma(at(100_000)) / zSigma(at(100_000))).toBeCloseTo(1, 4);
  });

  it("is finite for an empty history and floored away from zero", () => {
    expect(zSpread(at(0))).toBe(8 * 2);
    expect(zSigma(at(10, 0))).toBe(1e-9);
  });

  it("sigma() stays the raw estimate (it is what the UI shows as sd)", () => {
    expect(sigma(at(7))).toBeCloseTo(1.253 * 8, 12);
  });

  it("deviation: z is shrunk, delta and ratio are not, and the normal range follows the shrunk z", () => {
    const s = at(14, 4);
    const value = 50 + 1.1 * sigma(s); // raw z 1.1, shrunk 1.1 × 14/16 = 0.9625
    const d = deviation(value, s);
    expect(d.z).toBeCloseTo(0.9625, 12);
    expect(d.delta).toBeCloseTo(1.1 * sigma(s), 12);
    expect(d.ratio).toBeCloseTo(value / 50 - 1, 12);
    expect(d.inNormalRange).toBe(true);
    expect(deviation(50 + 1.2 * zSigma(s), s).inNormalRange).toBe(false);
  });
});

describe("BaselineSeedingTest", () => {
  const hrvBase4 = () => foldHistory([58, 61, 60, 59], hrvCfg);
  const rhrBase4 = () => foldHistory([52, 51, 53, 52], restingHRCfg);

  it("below seed is not usable, recovery null", () => {
    const hrvBase = foldHistory([58, 61, 60], hrvCfg);
    expect(isUsable(hrvBase)).toBe(false);
    const score = recoveryFromStates({
      hrv: 60,
      rhr: 52,
      hrvBaseline: hrvBase,
      rhrBaseline: foldHistory([52, 51, 53], restingHRCfg),
      sleepPerf: 0.9,
    });
    expect(score).toBeNull();
  });

  it("at seed is usable, recovery non-null and in [0, 100]", () => {
    expect(isUsable(hrvBase4())).toBe(true);
    const score = recoveryFromStates({ hrv: 60, rhr: 52, hrvBaseline: hrvBase4(), rhrBaseline: rhrBase4(), sleepPerf: 0.9 });
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThanOrEqual(0);
    expect(score!).toBeLessThanOrEqual(100);
  });

  it("null nights skip and hold and do not count", () => {
    expect(isUsable(foldHistory([58, null, 61, null, 60], hrvCfg))).toBe(false);
  });

  const withResp = (resp: number | null, respBaseline: ReturnType<typeof foldHistory> | null) =>
    recoveryFromStates({ hrv: 59.5, rhr: 52, resp, hrvBaseline: hrvBase4(), rhrBaseline: rhrBase4(), respBaseline, sleepPerf: 0.9 })!;

  it("resp above baseline lowers recovery, below raises it", () => {
    const respBase = foldHistory([14.5, 14.4, 14.6, 14.5, 14.5], respCfg);
    expect(isUsable(respBase)).toBe(true);
    const neutral = withResp(null, respBase);
    expect(withResp(17.5, respBase)).toBeLessThan(neutral);
    expect(withResp(12.0, respBase)).toBeGreaterThan(neutral);
  });

  it("null resp renormalizes to the pre-wiring score", () => {
    const respBase = foldHistory([14.5, 14.4, 14.6, 14.5, 14.5], respCfg);
    expect(withResp(null, respBase)).toBeCloseTo(withResp(null, null), 9);
  });
});

describe("deviation and rollingMeanSD", () => {
  it("z is (value − baseline) / (1.253 × spread), shrunk by n / (n + k)", () => {
    const s = { baseline: 50, spread: 4, nValid: 14, nightsSinceUpdate: 0, status: "trusted" as const };
    const d = deviation(55, s);
    expect(d.z).toBeCloseTo((5 / (1.253 * 4)) * (14 / 16), 12);
    expect(d.delta).toBe(5);
    expect(d.ratio).toBeCloseTo(0.1, 12);
    expect(d.inNormalRange).toBe(true);
  });

  it("trailing mean and sample SD, σ floored then stored in abs-dev units", () => {
    const s = rollingMeanSD([10, null, 12, 14, 400], hrvCfg); // 400 is out of range
    expect(s.baseline).toBe(12);
    expect(s.spread).toBeCloseTo(2 / 1.253, 12); // SD 2 is over the floor at 12 ms (version 36; was 5 ms)
    expect(rollingMeanSD([12, 12.2, 12.1], hrvCfg).spread).toBeCloseTo(floorOf(hrvCfg, 12.1, 3) / 1.253, 12); // under it
    const wide = rollingMeanSD([20, 40, 60], hrvCfg);
    expect(wide.spread).toBeCloseTo(20 / 1.253, 12);
    expect(rollingMeanSD([20, 40, 60], hrvCfg, 2).baseline).toBe(50);
  });

  it("keeps every noop metric config", () => {
    expect(Object.keys(metricCfg).sort()).toEqual(
      ["daytime_hr", "daytime_rmssd", "hrv", "readiness_hrv_ln", "resp", "resting_hr", "skin_temp", "strain"].sort(),
    );
    expect(metricCfg.resp.floorSpread).toBe(0.5);
    expect(metricCfg.resting_hr.floorSpread).toBe(1); // version 36 (was 2)
    expect(metricCfg.hrv).toMatchObject({ floorSpread: 1, floorRel: 0.05, youngFloorScale: 2 }); // version 36 (was 5)
  });
});

describe("isoEpochDay", () => {
  it("is Hinnant's days-from-civil", () => {
    expect(isoEpochDay("1970-01-01")).toBe(0);
    expect(isoEpochDay("2000-03-01")).toBe(11017);
    expect(isoEpochDay("1969-12-31")).toBe(-1);
    expect(isoEpochDay("2026-10-02")).toBe(Date.UTC(2026, 9, 2) / 86_400_000);
    expect(isoEpochDay("0000-03-01")).toBe(-719468); // the algorithm's own anchor
    expect(isoEpochDay("0000-01-01")).toBe(-719528); // yy = −1 exercises the floor division
    expect(isoEpochDay("2026-13-01")).toBeNull();
    expect(isoEpochDay("not-a-date")).toBeNull();
  });
});

describe("NightsSinceNewestValidNightTest", () => {
  it("days since the newest night carrying a valid hrv", () => {
    expect(nightsSinceNewestValidNight(["2026-07-01", "2026-07-02", "2026-07-03"], [60, null, 62], "2026-07-17")).toBe(14);
  });
  it("a null-hrv newer night does not count", () => {
    expect(nightsSinceNewestValidNight(["2026-07-01", "2026-07-10"], [55, null], "2026-07-17")).toBe(16);
  });
  it("null when there is no valid night", () => {
    expect(nightsSinceNewestValidNight(["2026-07-01"], [null], "2026-07-17")).toBeNull();
  });
  it("null when today precedes the newest night", () => {
    expect(nightsSinceNewestValidNight(["2026-07-20"], [60], "2026-07-17")).toBeNull();
  });
  it("crosses month and year boundaries", () => {
    expect(nightsSinceNewestValidNight(["2025-12-31"], [50], "2026-01-01")).toBe(1);
    expect(nightsSinceNewestValidNight(["2026-01-31"], [50], "2026-03-03")).toBe(31);
  });
  it("null on an unparseable day key", () => {
    expect(nightsSinceNewestValidNight(["not-a-date"], [50], "2026-07-17")).toBeNull();
  });
});

describe("RecentHrvCoverageTest", () => {
  it("counts observed nights and the empty ones among them", () => {
    const days = ["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"];
    expect(recentHrvCoverage(days, [44, null, null, 47, null], "2026-09-06")).toEqual({ observed: 5, missing: 3 });
  });
  it("a day outside the window is not observed", () => {
    expect(recentHrvCoverage(["2026-08-01", "2026-09-06"], [null, null], "2026-09-06", 14)).toEqual({ observed: 1, missing: 1 });
  });
  it("a day after today is ignored", () => {
    expect(recentHrvCoverage(["2026-09-07"], [null], "2026-09-06")).toEqual({ observed: 0, missing: 0 });
  });
  it("a complete window reports nothing missing", () => {
    expect(recentHrvCoverage(["2026-09-05", "2026-09-06"], [50, 51], "2026-09-06")).toEqual({ observed: 2, missing: 0 });
  });
  it("empty and unparseable inputs are zero", () => {
    expect(recentHrvCoverage([], [], "2026-09-06").observed).toBe(0);
    expect(recentHrvCoverage(["2026-09-06"], [null], "not-a-day").observed).toBe(0);
  });
});

describe("VitalCarryStalenessTest", () => {
  it("cutoffKey is today minus carry days, across months, years and leap days", () => {
    expect(cutoffKey("2026-08-13", 7)).toBe("2026-08-06");
    expect(cutoffKey("2026-08-13", 0)).toBe("2026-08-13");
    expect(cutoffKey("2026-03-03", 7)).toBe("2026-02-24");
    expect(cutoffKey("2026-01-03", 7)).toBe("2025-12-27");
    expect(cutoffKey("2028-03-05", 7)).toBe("2028-02-27");
    expect(cutoffKey("not-a-day", 7)).toBe("not-a-day");
  });

  it("freshestCarried judges only the newest point, inclusive at the edge", () => {
    expect(freshestCarried([["2026-08-01", 16.0], ["2026-08-10", 15.6]], "2026-08-13", 7)).toEqual(["2026-08-10", 15.6]);
    expect(freshestCarried([["2026-07-28", 16.0], ["2026-07-29", 16.2], ["2026-07-30", 15.6]], "2026-08-13", 7)).toBeNull();
    expect(freshestCarried([["2026-08-06", 15.6]], "2026-08-13", 7)?.[1]).toBe(15.6);
    expect(freshestCarried([["2026-08-05", 15.6]], "2026-08-13", 7)).toBeNull();
    expect(freshestCarried([["2026-07-30", 15.6], ["2026-08-12", 14.1]], "2026-08-13", 7)?.[1]).toBe(14.1);
    expect(freshestCarried([["2026-08-13", 14.1]], "2026-08-13", 7)?.[1]).toBe(14.1);
    expect(freshestCarried([], "2026-08-13")).toBeNull();
  });
});

describe("the illness hold (SCORING_VERSION 30)", () => {
  const step = (zs: (number | null)[]) => {
    let s: HoldState = noHold;
    return zs.map((z) => {
      const n = nextHold(s, z);
      s = { run: n.run, held: n.held };
      return n.hold;
    });
  };

  it("holds from the second illness-ward night of a run, not the first", () => {
    expect(illnessHold).toEqual({ zOn: 1.0, minRun: 2, maxNights: 21 });
    expect(step([1.2])).toEqual([false]);
    expect(step([1.2, 1.0, 3])).toEqual([false, true, true]);
    expect(step([0.99, 1.5])).toEqual([false, false]);
  });

  it("a night under the threshold, or one that can't be measured, breaks the run", () => {
    expect(step([1.5, 1.5, 0.5, 1.5, 1.5])).toEqual([false, true, false, false, true]);
    expect(step([1.5, 1.5, null, 1.5])).toEqual([false, true, false, false]);
  });

  it("holds at most 21 nights in a row, so a lasting change is still absorbed; a new run starts over", () => {
    const long = step(Array(30).fill(2));
    expect(long.filter(Boolean)).toHaveLength(21);
    expect(long.slice(0, 23)).toEqual([false, ...Array(21).fill(true), false]);
    expect(long.slice(23).some(Boolean)).toBe(false);
    expect(step([...Array(30).fill(2), 0, 2, 2])).toEqual([...long, false, false, true]);
  });

  it("illnessWardZ: HRV down and resting HR up against usable baselines, else null", () => {
    const hrvB = foldHistory(Array.from({ length: 30 }, (_, i) => 50 + (i % 5) - 2), hrvCfg);
    const rhrB = foldHistory(Array.from({ length: 30 }, (_, i) => 58 + (i % 3) - 1), restingHRCfg);
    const z = illnessWardZ(40, 64, hrvB, rhrB)!;
    expect(z).toBeCloseTo((-deviation(40, hrvB).z + deviation(64, rhrB).z) / 2, 12);
    expect(z).toBeGreaterThan(1);
    expect(illnessWardZ(null, 64, hrvB, rhrB)).toBeNull();
    expect(illnessWardZ(40, 64, foldHistory([50, 51], hrvCfg), rhrB)).toBeNull(); // not usable yet
    // Version 32: usable but still young (under 8 nights) is not enough either.
    expect(illnessWardZ(40, 64, foldHistory([50, 52, 48, 51, 49, 50, 52], hrvCfg), rhrB)).toBeNull();
    expect(illnessWardZ(40, 64, foldHistory([50, 52, 48, 51, 49, 50, 52, 49], hrvCfg), rhrB)).not.toBeNull();
  });
});

describe("the robust first week (SCORING_VERSION 32)", () => {
  it("one glitch among the first nights is trimmed: centre and spread come from the normal nights (version 31: spread about 22)", () => {
    const xs = [50, 52, 48, 180, 51, 49, 50];
    const s = foldHistory(xs, hrvCfg);
    expect(s.baseline).toBeCloseTo((50 + 52 + 48 + 51 + 49 + 50) / 6, 12);
    expect(s.spread).toBe(floorOf(hrvCfg, s.baseline, 7)); // the six normal nights barely vary
    expect(foldHistory(xs, hrvCfg, false).spread).toBeGreaterThan(15); // the plain young regime
  });

  it("a glitch on the very first night doesn't become the seed", () => {
    const s = foldHistory([150, 50, 52, 49], hrvCfg);
    expect(s.baseline).toBeCloseTo((50 + 52 + 49) / 3, 12);
    expect(foldHistory([150, 50, 52, 49], hrvCfg, false).baseline).toBeGreaterThan(80);
  });

  it("keeps at most 8 early values, and from night 9 the EWMA takes over without them", () => {
    const xs = [50, 60, 40, 55, 45, 52, 48, 51];
    expect(foldHistory(xs, hrvCfg).early).toEqual(xs);
    const after = update(foldHistory(xs, hrvCfg), 53, hrvCfg);
    expect(after.early).toBeUndefined();
    expect(after.nValid).toBe(9);
    const s8 = foldHistory(xs, hrvCfg);
    const lb = lambda(hrvCfg.halfLifeB);
    expect(after.baseline).toBeCloseTo(lb * 53 + (1 - lb) * s8.baseline, 12);
  });

  it("missing and out-of-range nights don't enter the early values", () => {
    expect(foldHistory([50, null, 60, 999, 40], hrvCfg).early).toEqual([50, 60, 40]);
  });

  it("the re-fold mode (no hard gate; Readiness) keeps version 31's young regime and stores nothing", () => {
    const s = foldHistory([50, 70, 40, 60], hrvCfg, false);
    expect(s.early).toBeUndefined();
    expect(s.baseline).not.toBe(55);
  });
});

describe("a run of hard rejections restarts the baseline (SCORING_VERSION 33)", () => {
  const settled = () => foldHistory(repeat(50, 20), hrvCfg); // centre 50, spread at the 5 ms floor: the gate is ±25
  const fold = (s: BaselineState, xs: (number | null)[], reject = true) => xs.reduce<BaselineState>((st, v) => update(st, v, hrvCfg, reject), s);

  it("7 values in a row beyond the gate on one side: a fresh baseline from them (version 32 stayed at 50)", () => {
    expect(restartAfterRejections).toBe(7);
    const six = fold(settled(), repeat(120, 6));
    expect(six).toMatchObject({ baseline: 50, nValid: 20, rejected: { side: 1, values: repeat(120, 6) } });
    const seven = update(six, 120, hrvCfg);
    expect(seven).toEqual(foldHistory(repeat(120, 7), hrvCfg));
    expect(seven).toMatchObject({ baseline: 120, nValid: 7, status: "provisional" });
    expect(seven.rejected).toBeUndefined();
  });

  it("an accepted value clears the run", () => {
    const s = fold(settled(), [...repeat(120, 6), 51]);
    expect(s.rejected).toBeUndefined();
    expect(update(s, 120, hrvCfg).rejected).toEqual({ side: 1, values: [120] });
  });

  it("a rejection on the other side starts a new run", () => {
    expect(fold(settled(), [...repeat(120, 6), 10]).rejected).toEqual({ side: -1, values: [10] });
  });

  it("missing and out-of-range nights inside the run don't break it", () => {
    const s = fold(settled(), [120, 120, null, 120, 999, 120, 120, null, 120]);
    expect(s.rejected?.values).toHaveLength(6);
    expect(update(s, 120, hrvCfg)).toMatchObject({ baseline: 120, nValid: 7 });
  });

  it("the re-fold mode (Readiness) never restarts, and the stale rule is unchanged", () => {
    expect(fold(settled(), repeat(120, 10), false).nValid).toBe(30);
    const s = fold(settled(), repeat(120, 3));
    expect(s.nightsSinceUpdate).toBe(0); // a rejected night still counts as seen
  });
});
