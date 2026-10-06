import { describe, expect, it } from "vitest";
import {
  cutoffKey,
  deviation,
  earlyHalfLifeB,
  foldHistory,
  freshestCarried,
  hrvCfg,
  isoEpochDay,
  isTrusted,
  isUsable,
  lambda,
  metricCfg,
  nightsSinceNewestValidNight,
  recentHrvCoverage,
  respCfg,
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

  it("young regime: half-life 3, spread × 2.5 clamp, no hard reject", () => {
    const young = foldHistory(repeat(50, 4), hrvCfg); // baseline 50, spread at the 5 ms floor
    expect(young).toMatchObject({ baseline: 50, spread: 5, nValid: 4 });
    // 80 is 6× spread away: past the hard gate, but young, so it folds at the fast centre half-life.
    const s = update(young, 80, hrvCfg);
    const lb = 1 - 0.5 ** (1 / earlyHalfLifeB);
    const ls = 1 / 4; // the spread is still a running mean: 1/n beats the 21-night λ
    expect(s.nValid).toBe(5);
    expect(s.baseline).toBeCloseTo(50 + 30 * lb, 12);
    expect(s.spread).toBeCloseTo(Math.max(5, ls * Math.abs(80 - s.baseline) + (1 - ls) * 5), 12);
    // Clamp widens to ±3 × 2.5 × spread = ±37.5 while young.
    expect(update(young, 100, hrvCfg).baseline).toBeCloseTo(50 + 37.5 * lb, 12);
  });

  it("after 8 nights a value 6× spread away is rejected and leaves the baseline unchanged", () => {
    const settled = foldHistory(repeat(50, 8), hrvCfg);
    const s = update(settled, 80, hrvCfg);
    expect(s).toEqual({ ...settled, nightsSinceUpdate: 0 });
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
      spread: 2,
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
  const lb3 = lambda(earlyHalfLifeB);
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
        expect(sdZShrunk, `n=${n}`).toBeLessThan(1.1);
        expect(sdZShrunk, `n=${n}`).toBeLessThan(sdZ);
      }
    });
  }

  it("a wobble under the floor still sits on the floor", () => {
    expect(simulate({ cfg: hrvCfg, mu: 50, sd: 3 }, 7).sigma).toBeCloseTo(1.253 * hrvCfg.floorSpread, 1);
    expect(simulate({ cfg: restingHRCfg, mu: 55, sd: 1 }, 30).sigma).toBeCloseTo(1.253 * restingHRCfg.floorSpread, 1);
  });

  it("the floor seed drops out on night 2: the spread is that night's deviation alone", () => {
    // Night 2's centre moves λ(3) of the way to 70; the floor seed gets weight 1 − 1/1 = 0.
    expect(foldHistory([50, 70], hrvCfg).spread).toBeCloseTo(20 * (1 - lb3), 12);
  });

  it("the spread is the plain mean of the absolute deviations over the first nights", () => {
    // Hand fold of 50, 70, 40, 60 (young: centre half-life 3, ±7.5 × spread Winsor band, so nothing clamps).
    const b2 = 50 + lb3 * (70 - 50);
    const d2 = Math.abs(70 - b2);
    const b3 = b2 + lb3 * (40 - b2);
    const d3 = Math.abs(40 - b3);
    const b4 = b3 + lb3 * (60 - b3);
    const d4 = Math.abs(60 - b4);
    const s = foldHistory([50, 70, 40, 60], hrvCfg);
    expect(s.baseline).toBeCloseTo(b4, 12);
    expect(s.spread).toBeCloseTo((d2 + d3 + d4) / 3, 12);
  });

  it("the floor still binds on each night of the running mean", () => {
    // Deviations of 1 ms average to well under the 5 ms floor.
    expect(foldHistory([50, 51, 50, 51, 50], hrvCfg).spread).toBe(hrvCfg.floorSpread);
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
    const s = foldHistory(repeat(50, 40), hrvCfg);
    expect(s.spread).toBe(hrvCfg.floorSpread);
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
    expect(s.spread).toBeCloseTo(5 / 1.253, 12); // SD 2 is under the 5 ms floor
    const wide = rollingMeanSD([20, 40, 60], hrvCfg);
    expect(wide.spread).toBeCloseTo(20 / 1.253, 12);
    expect(rollingMeanSD([20, 40, 60], hrvCfg, 2).baseline).toBe(50);
  });

  it("keeps every noop metric config", () => {
    expect(Object.keys(metricCfg).sort()).toEqual(
      ["daytime_hr", "daytime_rmssd", "hrv", "readiness_hrv_ln", "resp", "resting_hr", "skin_temp", "strain"].sort(),
    );
    expect(metricCfg.resp.floorSpread).toBe(0.5);
    expect(metricCfg.resting_hr.floorSpread).toBe(2);
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
