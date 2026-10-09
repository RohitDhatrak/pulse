import { describe, expect, it } from "vitest";
import { toStrainScale, trimpToStrain } from "../scoring/strain";
import { recoveryLogMultiplier, strainTarget, strainTargetConfig, type StrainTargetInput, typicalSession } from "./strainTarget";

const c = strainTargetConfig;
/** TRIMP → 0–21, as the target displays it. */
const S = (t: number) => toStrainScale(trimpToStrain(t));
/** 0–21 → TRIMP (inverse of S, up to Effort's 2-dp rounding). */
const T = (s: number) => Math.pow(7201, s / 21) - 1;
/** `weeks` repeats of a 7-day pattern of daily TRIMP, oldest first. */
const pattern = (week: number[], days = 28) => Array.from({ length: days }, (_, i) => week[i % 7]);

const PROFILES: Record<string, number[]> = {
  "light 4×50": [50, 6, 50, 6, 50, 50, 6],
  "moderate 4×118": [118, 9, 118, 9, 118, 118, 9],
  "heavy 5×300": [300, 15, 300, 300, 300, 300, 15],
  "daily 7×150": [150, 150, 150, 150, 150, 150, 150],
};
const target = (over: Partial<StrainTargetInput> & { priorLoad: (number | null)[] }) =>
  strainTarget({ priorRecovery: [], recovery: 58, acwr: 1.0, ...over })!;
/** The range as multiples of the typical session, read back in load. */
const multiples = (t: NonNullable<ReturnType<typeof strainTarget>>) => [T(t.low) / T(t.base), T(t.high) / T(t.base)];

describe("Recovery multiplier (before centring)", () => {
  it("anchors: 10 → 0.35×, a normal night (58) → 1×, 90 → 1.4×; flat outside", () => {
    expect(Math.exp(recoveryLogMultiplier(58))).toBeCloseTo(1, 12);
    expect(Math.exp(recoveryLogMultiplier(10))).toBeCloseTo(0.35, 12);
    expect(Math.exp(recoveryLogMultiplier(90))).toBeCloseTo(1.4, 12);
    expect(recoveryLogMultiplier(0)).toBe(recoveryLogMultiplier(10));
    expect(recoveryLogMultiplier(100)).toBe(recoveryLogMultiplier(90));
  });

  it("is linear in log between anchors and strictly increasing from 10 to 90", () => {
    expect(recoveryLogMultiplier(34)).toBeCloseTo(Math.log(0.35) / 2, 12);
    expect(recoveryLogMultiplier(74)).toBeCloseTo(Math.log(1.4) / 2, 12);
    for (let r = 10; r < 90; r++) expect(recoveryLogMultiplier(r + 1)).toBeGreaterThan(recoveryLogMultiplier(r));
  });
});

describe("typical session", () => {
  it("is the median of the training days: rest days (under 30 % of the 90th percentile) are left out", () => {
    expect(typicalSession(pattern(PROFILES["moderate 4×118"]))).toBe(118);
    expect(typicalSession(pattern(PROFILES["daily 7×150"]))).toBe(150);
    expect(typicalSession([9, 9, 9, 100, 120, 140])).toBe(120);
  });

  it("a sedentary history is its own typical day (every day is ≥ 30 % of its 90th percentile); empty is null", () => {
    // 16 days at 8 and 12 at 14: all count, and the median is 8.
    expect(typicalSession(pattern([14, 8, 8, 14, 8, 14, 8]))).toBe(8);
    expect(typicalSession([])).toBeNull();
  });
});

describe("strainTarget", () => {
  it("the same Recovery means the same multiple of your typical session for light, heavy and daily trainers", () => {
    // Version 10 asked a daily trainer for up to 3.0× a session on green and a light one for 0.84×.
    for (const R of [15, 35, 58, 67, 80, 95]) {
      const ms = Object.values(PROFILES).map((w) => multiples(target({ priorLoad: pattern(w), recovery: R })));
      for (const m of ms) {
        expect(m[0]).toBeCloseTo(ms[0][0], 1);
        expect(m[1]).toBeCloseTo(ms[0][1], 1);
      }
    }
  });

  it("uncentred, a normal night (58) asks for your typical session in the middle of a ±25 % range", () => {
    const t = target({ priorLoad: pattern(PROFILES["moderate 4×118"]), recovery: 58 });
    const [lo, hi] = multiples(t);
    expect(Math.sqrt(lo * hi)).toBeCloseTo(1, 1);
    expect(lo).toBeCloseTo(1 / c.width, 1);
    expect(hi).toBeCloseTo(c.width, 1);
    expect(t.base).toBeCloseTo(S(118), 10);
  });

  it("changes smoothly with Recovery: under 0.2 Strain points per Recovery point, including 33→34 and 66→67", () => {
    const at = (R: number) => target({ priorLoad: pattern(PROFILES["moderate 4×118"]), recovery: R });
    for (let R = 0; R < 100; R++) {
      expect(Math.abs(at(R + 1).low - at(R).low)).toBeLessThan(0.2);
      expect(Math.abs(at(R + 1).high - at(R).high)).toBeLessThan(0.2);
    }
    expect(at(67).band).toBe("green");
    expect(at(66).band).toBe("yellow");
  });

  it("is about one Strain point wide (÷1.25 … ×1.25 in load)", () => {
    for (const R of [20, 58, 90]) {
      const t = target({ priorLoad: pattern(PROFILES["moderate 4×118"]), recovery: R });
      expect(t.high - t.low).toBeGreaterThan(0.8);
      expect(t.high - t.low).toBeLessThan(1.3);
    }
  });

  it("is centred on your own last 28 Recoveries: your usual Recovery asks for your typical session", () => {
    for (const usual of [25, 58, 85]) {
      const t = target({ priorLoad: pattern(PROFILES["moderate 4×118"]), priorRecovery: Array(28).fill(usual), recovery: usual });
      const [lo, hi] = multiples(t);
      expect(Math.sqrt(lo * hi)).toBeCloseTo(1, 1);
    }
    // Better than your usual asks for more, worse for less.
    const usual = { priorLoad: pattern(PROFILES["moderate 4×118"]), priorRecovery: Array(28).fill(40) };
    expect(target({ ...usual, recovery: 70 }).high).toBeGreaterThan(target({ ...usual, recovery: 40 }).high);
    expect(target({ ...usual, recovery: 20 }).high).toBeLessThan(target({ ...usual, recovery: 40 }).high);
  });

  it(`centring needs ${c.minRecoveriesToCentre} prior Recoveries; fewer leave the fixed anchors`, () => {
    const loads = pattern(PROFILES["moderate 4×118"]);
    const few = target({ priorLoad: loads, priorRecovery: Array(c.minRecoveriesToCentre - 1).fill(90), recovery: 58 });
    expect(few).toEqual(target({ priorLoad: loads, recovery: 58 }));
    const enough = target({ priorLoad: loads, priorRecovery: Array(c.minRecoveriesToCentre).fill(90), recovery: 58 });
    expect(enough.high).toBeLessThan(few.high);
  });

  it(`needs ${c.minDays} days with a load; under ${c.estimateBelowDays} it is your own range, tagged as an estimate`, () => {
    const loads = (n: number) => [...Array(28 - n).fill(null), ...pattern(PROFILES["moderate 4×118"], n)];
    expect(strainTarget({ priorLoad: loads(c.minDays - 1), priorRecovery: [], recovery: 80, acwr: null })).toBeNull();
    const early = target({ priorLoad: loads(c.minDays), recovery: 80 });
    expect(early.coldStart).toBe(true);
    // Version 10 gave every new user 14–18 on green (372–2,024 TRIMP); now it is about their own sessions.
    expect(early.high).toBeLessThan(14);
    expect(early.base).toBeCloseTo(S(118), 10);
    expect(target({ priorLoad: loads(c.estimateBelowDays), recovery: 80 }).coldStart).toBe(false);
  });

  it("the typical session grows at most 10 % over the previous 28 days", () => {
    const doubled = [...pattern([100, 9, 100, 9, 100, 100, 9]), ...pattern([200, 9, 200, 9, 200, 200, 9])];
    expect(target({ priorLoad: doubled }).base).toBeCloseTo(S(110), 10);
    // A falling month is not held up, and an earlier month with under 14 loads does not limit.
    const halved = [...pattern([200, 9, 200, 9, 200, 200, 9]), ...pattern([100, 9, 100, 9, 100, 100, 9])];
    expect(target({ priorLoad: halved }).base).toBeCloseTo(S(100), 10);
    const sparse = [...Array(28).fill(null).map((v, i) => (i < 13 ? 100 : v)), ...pattern([200, 9, 200, 9, 200, 200, 9])];
    expect(target({ priorLoad: sparse }).base).toBeCloseTo(S(200), 10);
  });

  it("after 8 light weeks, a beginner's sessions are the target from the start (version 25: held at 1.1 × the light days for 32 days)", () => {
    const light = Array(56).fill(10);
    const training = pattern([100, 10, 100, 10, 100, 100, 10], 70);
    const baseAfter = (days: number) => target({ priorLoad: [...light, ...training.slice(0, days)] }).base;
    expect(baseAfter(3)).toBeCloseTo(S(10), 10); // two sessions in 28 days: still under the 90th percentile
    for (const days of [7, 14, 28, 32, 33, 60]) expect(baseAfter(days)).toBeCloseTo(S(100), 10);
    expect(S(11).toFixed(1)).toBe("5.9"); // where version 25 held it
  });

  it("the limit needs 4 earlier sessions at today's level: 3 don't limit, 4 do", () => {
    const now = pattern([200, 9, 200, 9, 200, 200, 9]);
    const earlierWith = (n: number) => Array.from({ length: 28 }, (_, i) => (i % 7 === 0 && i / 7 < n ? 100 : 9));
    expect(target({ priorLoad: [...earlierWith(3), ...now] }).base).toBeCloseTo(S(200), 10);
    expect(target({ priorLoad: [...earlierWith(4), ...now] }).base).toBeCloseTo(S(110), 10);
    expect(c.minEarlierSessions).toBe(4);
  });

  it("earlier loads under 30 % of today's session aren't sessions: light days never hold the target down", () => {
    // Four earlier 50s are under 0.3 × 200 = 60, so nothing limits; four 60s are sessions, so the limit is 66.
    const now = pattern([200, 9, 200, 9, 200, 200, 9]);
    const earlier = (v: number) => Array.from({ length: 28 }, (_, i) => (i % 7 === 0 ? v : 9));
    expect(target({ priorLoad: [...earlier(50), ...now] }).base).toBeCloseTo(S(200), 10);
    expect(target({ priorLoad: [...earlier(60), ...now] }).base).toBeCloseTo(S(66), 10);
  });

  it("a 4-week break with the band on, back at the same level: no dip after the return", () => {
    const loads = [...pattern([118, 9, 118, 9, 118, 118, 9], 84), ...Array(28).fill(9), ...pattern([118, 9, 118, 9, 118, 118, 9], 63)];
    for (let d = 112 + 10; d <= loads.length; d++) expect(target({ priorLoad: loads.slice(0, d) }).base, `day +${d - 112}`).toBeCloseTo(S(118), 10);
  });

  it("ACWR above 1.3 caps the top at your typical session and keeps the width", () => {
    const loads = pattern(PROFILES["moderate 4×118"]);
    const free = target({ priorLoad: loads, recovery: 85, acwr: 1.3 });
    expect(free.acwrRule).toBeNull();
    const capped = target({ priorLoad: loads, recovery: 85, acwr: 1.31 });
    expect(capped.acwrRule).toBe("capped");
    expect(capped.high).toBeCloseTo(capped.base, 10);
    expect(capped.high - capped.low).toBeGreaterThan(0.8);
  });

  it("back from a break (no session in the last 5 days, worn or not) the top is your typical session", () => {
    const usual = pattern(PROFILES["moderate 4×118"], 21);
    const back = (recent: (number | null)[]) => target({ priorLoad: [...usual, ...recent], recovery: 85 });
    const sick = back([118, 118, 6, 6, 6, 6, 6]);
    expect(sick.acwrRule).toBe("returning");
    expect(sick.high).toBeCloseTo(sick.base, 10);
    expect(back([118, 118, null, null, 6, 6, 6]).acwrRule).toBe("returning");
    // Four quiet days is an ordinary gap, and a session anywhere in the last 5 days ends the break.
    expect(back([118, 118, 118, 6, 6, 6, 6]).acwrRule).toBeNull();
    expect(back([118, 6, 6, 118, 6, 6, 6]).acwrRule).toBeNull();
    // An ordinary 2-sessions-a-week pattern (gaps of 3 days) never reads as a break.
    for (let shift = 0; shift < 7; shift++) {
      const twice = Array.from({ length: 28 }, (_, i) => ([0, 3].includes((i + shift) % 7) ? 118 : 6));
      expect(target({ priorLoad: twice, recovery: 85 }).acwrRule).toBeNull();
    }
    // A ramp cap takes precedence in the label.
    expect(target({ priorLoad: [...usual, 118, 118, 6, 6, 6, 6, 6], recovery: 85, acwr: 1.5 }).acwrRule).toBe("capped");
  });

  it("is shifted, not squeezed, into the 4–19 display range", () => {
    // Sedentary on a very low Recovery: the range (≈ 2.2–3.0) moves up to start at 4 with its width intact.
    const loads = pattern([14, 8, 8, 14, 8, 14, 8]);
    const sedentary = target({ priorLoad: loads, recovery: 5 });
    const raw = [S((0.35 * 8) / c.width), S(0.35 * 8 * c.width)];
    expect(raw[0]).toBeLessThan(c.min);
    expect(sedentary.low).toBe(c.min);
    expect(sedentary.high - sedentary.low).toBeCloseTo(raw[1] - raw[0], 10);
    const huge = target({ priorLoad: pattern([5000, 50, 5000, 5000, 5000, 5000, 50]), recovery: 95 });
    expect(huge.high).toBe(c.max);
    expect(huge.high - huge.low).toBeGreaterThan(0.8);
  });

  it("the band follows today's Recovery", () => {
    const loads = pattern(PROFILES["moderate 4×118"]);
    expect([20, 50, 80].map((R) => target({ priorLoad: loads, recovery: R }).band)).toEqual(["red", "yellow", "green"]);
  });
});

describe("following the target for 26 weeks (closed loop)", () => {
  // A deterministic Recovery sequence around 58 with day-to-day correlation, like the seed's.
  const recoveries = (shift: number) => {
    let x = 42;
    let prev = 0;
    return Array.from({ length: 300 }, () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      prev = 0.5 * prev + 15 * (x / 2147483648 - 0.5) * 2;
      return Math.min(99, Math.max(1, 58 + shift + prev));
    });
  };
  /** Train 4 days a week at the middle of the range; rest days 9. Returns final ÷ starting typical session. */
  const follow = (shift: number, next: (input: StrainTargetInput) => { low: number; high: number } | null) => {
    const training = [0, 2, 4, 5];
    const loads: number[] = pattern(PROFILES["moderate 4×118"], 56);
    const recs = recoveries(shift);
    const seen: number[] = [];
    for (let d = 0; d < 7 * 26; d++) {
      const t = next({ priorLoad: loads, priorRecovery: seen, recovery: recs[d], acwr: null })!;
      seen.push(recs[d]);
      loads.push(training.includes(d % 7) ? Math.sqrt(T(t.low) * T(t.high)) : 9);
    }
    return typicalSession(loads.slice(-28))! / 118;
  };

  it("stays within ×0.6–1.8 of where it started, for usual, good and poor Recovery", () => {
    for (const shift of [0, 12, -12]) {
      const end = follow(shift, strainTarget);
      expect(end, `shift ${shift}`).toBeGreaterThan(0.6);
      expect(end, `shift ${shift}`).toBeLessThan(1.8);
    }
  });

  it("the version 10 formula (mean Strain × colour multipliers) collapsed to rest-day load", () => {
    const v10 = ({ priorLoad, recovery }: StrainTargetInput) => {
      const days = priorLoad.slice(-28).map((t) => S(t!));
      const base = days.reduce((a, v) => a + v, 0) / days.length;
      const [lo, hi] = recovery < 34 ? [0.5, 0.75] : recovery < 67 ? [0.8, 1.0] : [1.0, 1.25];
      let low = Math.max(4, lo * base);
      let high = Math.max(4, hi * base);
      if (high - low < 2) [low, high] = [Math.max(4, high - 2), Math.max(4, high - 2) + 2];
      return { low, high };
    };
    expect(follow(0, v10)).toBeLessThan(0.2);
  });
});
