import { describe, expect, it } from "vitest";
import { sigma } from "../scoring/baselines";
import { foldableStillMedian, foldDaytimeBaseline, foldGateSigma } from "../scoring/stressBase";
import type { BaselineState, HrSample } from "../scoring/types";
import { energyBank, minuteLoad } from "./energyBank";
import { demoteShortHighRuns, minuteMeanHr, rollingReference, stress, stressConfig, stressLevel, type StressInput } from "./stress";

const start = 1_790_000_000 - (1_790_000_000 % 86_400); // a UTC midnight
const N = 1440;
/** Four readings a minute at `bpm(m)`; null skips the minute. */
const hrFrom = (bpm: (m: number) => number | null): HrSample[] =>
  Array.from({ length: N }, (_, m) => bpm(m)).flatMap((b, m) =>
    b == null ? [] : [0, 15, 30, 45].map((s) => ({ ts: start + m * 60 + s, bpm: b })),
  );
const trusted: BaselineState = { baseline: 70, spread: 4 / 1.253, nValid: 30, nightsSinceUpdate: 0, status: "trusted" };
const run = (over: Partial<StressInput> = {}) =>
  stress({ start, end: start + N * 60, hr: hrFrom(() => 70), steps: [], excluded: [], baseline: trusted, ...over });
const at = (h: number, min = 0) => h * 60 + min;

describe("stressLevel", () => {
  it("maps your usual still level (z = 0) to 0.4 and +3σ above 2, within (0, 3)", () => {
    // Version 13: z0 = ln(6.5) / 1.5, so z = 0 reads 3 / (1 + 6.5) = 0.4 (was 0.29 against the calmest hour).
    expect(stressLevel(0)).toBeCloseTo(0.4, 12);
    expect(stressLevel(3)).toBeGreaterThan(2.7);
    expect(stressLevel(1.96)).toBeGreaterThan(2);
    expect(stressLevel(stressConfig.z0)).toBe(1.5);
    expect(stressLevel(-50)).toBeGreaterThanOrEqual(0);
    expect(stressLevel(50)).toBeLessThanOrEqual(3);
  });
});

describe("stress", () => {
  it("a still minute at baseline HR reads near 0", () => {
    const r = run();
    expect(r.minutes[at(10)]).toBeLessThan(0.5);
    expect(r.provisional).toBe(false);
    expect(r.sigmaBpm).toBeCloseTo(4, 10);
  });

  it("two still minutes in a row at +3σ read at least 2", () => {
    const r = run({ hr: hrFrom((m) => (m === at(10) || m === at(10, 1) ? 82 : 70)) });
    expect(r.minutes[at(10)]).toBeGreaterThanOrEqual(2);
    expect(r.minutes[at(10, 1)]).toBeGreaterThanOrEqual(2);
    expect(r.highMin).toBe(2);
  });

  it("a single high minute is a spike, not stress: it reads medium", () => {
    const r = run({ hr: hrFrom((m) => (m === at(10) ? 82 : 70)) });
    expect(r.minutes[at(10)]).toBeCloseTo(stressConfig.highFrom - 0.01, 12);
    expect(r.highMin).toBe(0);
    expect(r.mediumMin).toBe(1);
  });

  it("excludes minutes with steps within ±2 minutes", () => {
    const steps: number[] = [];
    steps[at(12)] = 30;
    const r = run({ steps });
    for (let d = -2; d <= 2; d++) expect(r.minutes[at(12) + d]).toBeNull();
    expect(r.minutes[at(12) - 3]).not.toBeNull();
    expect(r.minutes[at(12) + 3]).not.toBeNull();
  });

  it("excludes workout and sleep minutes, including partly covered ones", () => {
    const workout = { start: start + at(18) * 60 + 30, end: start + at(19) * 60 };
    const sleep = { start: start, end: start + at(7) * 60 };
    const r = run({ excluded: [workout, sleep] });
    expect(r.minutes[at(18)]).toBeNull();
    expect(r.minutes[at(18, 59)]).toBeNull();
    expect(r.minutes[at(19)]).not.toBeNull();
    expect(r.minutes.slice(0, at(7)).every((v) => v == null)).toBe(true);
    expect(r.minutes[at(7)]).not.toBeNull();
  });

  it("minutes without HR are not scored", () => {
    const r = run({ hr: hrFrom((m) => (m < at(9) ? null : 70)) });
    expect(r.minutes[at(8, 59)]).toBeNull();
    expect(r.hourly[8]).toBeNull();
    expect(r.hourly[9]).toBeCloseTo(stressLevel(0), 10);
  });

  it("falls back to the fixed σ, marked provisional, while the baseline is not usable", () => {
    const calibrating: BaselineState = { ...trusted, nValid: 2, status: "calibrating" };
    const r = run({ baseline: calibrating, hr: hrFrom((m) => (m === at(10) ? 82 : 70)) });
    expect(r.provisional).toBe(true);
    expect(r.sigmaBpm).toBeCloseTo(15 / 1.96, 10);
    expect(r.referenceHr).toBe(70);
    expect(r.minutes[at(10)]).toBeCloseTo(stressLevel(12 / (15 / 1.96)), 10);
  });

  it("with no accepted baseline day, scores against today's own median still HR", () => {
    const empty: BaselineState = { baseline: 97.5, spread: 3, nValid: 0, nightsSinceUpdate: 1, status: "calibrating" };
    // Waking hours 06–21 at 60 + hour: the median of 66..81 (60 minutes each) is 73.5; P10 of the hours is 67.5.
    const r = run({ baseline: empty, hr: hrFrom((m) => 60 + Math.floor(m / 60)) });
    expect(r.stillMedianHr).toBeCloseTo(73.5, 10);
    expect(r.referenceHr).toBeCloseTo(73.5, 10);
    expect(r.dayAggregate).toBeCloseTo(67.5, 10);
    expect(r.provisional).toBe(true);
  });

  it("stillMedianHr uses only waking still minutes, and needs 60 of them", () => {
    const steps: number[] = [];
    for (let m = at(9); m < at(10); m++) steps[m] = 30; // a moving hour at HR 120 drops out
    const hr = hrFrom((m) => (m < at(6) || m >= at(22) ? 50 : m >= at(9) && m < at(10) ? 120 : 70));
    expect(run({ hr, steps }).stillMedianHr).toBe(70);
    // Only 59 waking still minutes: no median.
    const sparse = hrFrom((m) => (m >= at(12) && m < at(12, 59) ? 70 : null));
    expect(run({ hr: sparse }).stillMedianHr).toBeNull();
    expect(run({ hr: hrFrom((m) => (m >= at(12) && m < at(13) ? 70 : null)) }).stillMedianHr).toBe(70);
  });

  it("dayAggregate is P10 of waking hours with enough still minutes", () => {
    const steps: number[] = [];
    // Hour 6 has HR 50 but is mostly moving, so it drops out.
    for (let m = at(6); m < at(6, 50); m++) steps[m] = 10;
    const r = run({ steps, hr: hrFrom((m) => (m < at(7) ? 50 : 70)) });
    expect(r.dayAggregate).toBe(70);
  });

  it("summarises minutes by band, the hourly means and the average", () => {
    // 10:00–10:29 at +3σ (high), 10:30–10:59 at +1.5σ (1.5, medium), the rest at baseline (low).
    const hr = hrFrom((m) => (m >= at(10) && m < at(10, 30) ? 82 : m >= at(10, 30) && m < at(11) ? 76 : 70));
    const r = run({ hr });
    expect(r.highMin).toBe(30);
    expect(r.mediumMin).toBe(30);
    expect(r.lowMin).toBe(N - 60);
    expect(r.hourly).toHaveLength(24);
    expect(r.hourly[10]).toBeCloseTo((stressLevel(3) + stressLevel(1.5)) / 2, 10);
    expect(r.average).toBeCloseTo((30 * stressLevel(3) + 30 * stressLevel(1.5) + (N - 60) * stressLevel(0)) / N, 10);
  });

  it("an empty day scores nothing", () => {
    const r = run({ hr: [] });
    expect(r.average).toBeNull();
    expect(r.lowMin + r.mediumMin + r.highMin).toBe(0);
    expect(r.dayAggregate).toBeNull();
  });
});

describe("demoteShortHighRuns (2 minutes in a row)", () => {
  const H = 2.5;
  const M = stressConfig.highFrom - 0.01;
  it("keeps runs of 2 or more, demotes lone highs to medium", () => {
    expect(demoteShortHighRuns([0.4, H, 0.4, H, H, 0.4, H, H, H])).toEqual([0.4, M, 0.4, H, H, 0.4, H, H, H]);
  });
  it("an unscored minute breaks a run; edges count", () => {
    expect(demoteShortHighRuns([H, null, H])).toEqual([M, null, M]);
    expect(demoteShortHighRuns([H, H, null])).toEqual([H, H, null]);
    expect(demoteShortHighRuns([H])).toEqual([M]);
  });
  it("leaves medium and low minutes alone, and exactly 2.0 counts as high", () => {
    expect(demoteShortHighRuns([1.5, 2, 2, 0.1])).toEqual([1.5, 2, 2, 0.1]);
    expect(demoteShortHighRuns([1.99, 2, 1.99])).toEqual([1.99, M, 1.99]);
  });
});

describe("minuteMeanHr", () => {
  it("averages each minute and ignores samples outside the grid", () => {
    const hr = [
      { ts: start - 1, bpm: 200 },
      { ts: start, bpm: 60 },
      { ts: start + 59, bpm: 70 },
      { ts: start + 120, bpm: 80 },
      { ts: start + 180, bpm: 200 },
    ];
    expect(minuteMeanHr(hr, start, start + 180)).toEqual([65, null, 80]);
  });
});

describe("simulated desk days (SCORING_VERSION 13 design check)", () => {
  // Deterministic generator: a still, awake day 07:00–23:00 with pottering steps, and everyday heart-rate changes
  // that are not stress (lunch, standing still, talking, coffee) on top of minute-to-minute noise.
  type Day = { hr: HrSample[]; steps: number[]; excluded: { start: number; end: number }[]; minuteHr: number[] };
  const makeDays = (opts: { noise: number; everyday: boolean; episode: number }, days: number) => {
    let x = 7;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648), x / 2147483648);
    const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
    return Array.from({ length: days }, (_, d): Day => {
      const s0 = start + d * 86_400;
      const extra = new Array<number>(N).fill(0);
      const steps: number[] = [];
      if (opts.everyday) {
        for (let m = at(13); m < at(15); m++) extra[m] += 7 * Math.exp(-(m - at(13)) / 60); // lunch
        for (const c of [at(9), at(14)]) for (let m = c; m < c + 60; m++) extra[m] += 3; // coffee
        for (let k = 0; k < 4; k++) for (let m = at(9) + k * 120; m < at(9) + k * 120 + 15; m++) extra[m] += 6; // talking
        for (let k = 0; k < 16; k++) for (let m = at(7) + k * 60 + 30; m < at(7) + k * 60 + 36; m++) extra[m] += 10; // standing still
      }
      if (opts.episode && d % 2 === 0) for (let m = at(10, 30); m < at(11); m++) extra[m] += opts.episode;
      for (let m = at(7); m < at(23); m++) if (rnd() < 0.14) steps[m] = 30;
      const shift = 2 * g();
      const minuteHr = Array.from({ length: N }, (_, m) => {
        const circ = 5 * Math.max(0, Math.sin((Math.PI * (m / 60 - 7)) / 15));
        return 69 + circ + shift + extra[m] + opts.noise * g();
      });
      return {
        hr: minuteHr.map((bpm, m) => ({ ts: s0 + m * 60 + 30, bpm })),
        steps,
        excluded: [{ start: s0, end: s0 + at(7) * 60 }, { start: s0 + at(23) * 60, end: s0 + N * 60 }],
        minuteHr,
      };
    });
  };
  /** Runs `days`, folding the baseline as the pipeline does; returns the last 10 days' results. */
  const simulate = (days: Day[], version: "v12" | "v13") => {
    const fold: (number | null)[] = [];
    return days.map((day, d) => {
      const s0 = start + d * 86_400;
      const r = stress({ start: s0, end: s0 + N * 60, hr: day.hr, steps: day.steps, excluded: day.excluded, baseline: foldDaytimeBaseline(fold) });
      if (version === "v13") {
        fold.push(r.stillMedianHr);
        return { r, minutes: r.minutes };
      }
      // Version 12: P10-of-hours reference, z0 1.5, no run rule (recomputed from the same still minutes and σ).
      fold.push(r.dayAggregate);
      const ref = foldDaytimeBaseline(fold.slice(0, -1));
      const reference = ref.nValid > 0 ? ref.baseline : r.dayAggregate!;
      const minutes = r.minutes.map((v, m) => (v == null ? null : 3 / (1 + Math.exp(-1.5 * ((day.minuteHr[m] - reference) / r.sigmaBpm - 1.5)))));
      return { r, minutes };
    }).slice(-10);
  };
  const high = (xs: (number | null)[], from = 0, to = N) => xs.slice(from, to).filter((v) => v != null && v >= 2).length;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  it("an ordinary desk day reads at most 60 % of version 12's high minutes", () => {
    const days = makeDays({ noise: 3.5, everyday: true, episode: 0 }, 40);
    const v12 = avg(simulate(days, "v12").map((x) => high(x.minutes)));
    const v13 = avg(simulate(days, "v13").map((x) => high(x.minutes)));
    expect(v12).toBeGreaterThan(40); // the problem: well over half an hour of "high" with no stress at all
    expect(v13).toBeLessThanOrEqual(0.6 * v12);
  });

  it("a clean day (demo-like) has almost no high minutes", () => {
    const days = makeDays({ noise: 1.6, everyday: false, episode: 0 }, 40);
    expect(avg(simulate(days, "v13").map((x) => high(x.minutes)))).toBeLessThanOrEqual(5);
  });

  it("a real 30-minute episode (+15 bpm) on a desk day is still at least 80 % high", () => {
    const days = makeDays({ noise: 3.5, everyday: true, episode: 15 }, 40);
    const res = simulate(days, "v13").filter((_, i) => (30 + i) % 2 === 0);
    const caught = avg(res.map((x) => high(x.minutes, at(10, 30), at(11)) / x.minutes.slice(at(10, 30), at(11)).filter((v) => v != null).length));
    expect(caught).toBeGreaterThanOrEqual(0.8);
  });

  it("a calm desk day leaves the Energy Bank inside its 15–40 target", () => {
    const days = makeDays({ noise: 3.5, everyday: true, episode: 0 }, 40);
    const ends = simulate(days, "v13").map((x, i) => {
      const s0 = start + (30 + i) * 86_400;
      return energyBank({
        start: s0,
        wake: s0 + at(7) * 60,
        until: s0 + at(23) * 60,
        recoveryWithoutSleep: 60,
        sleepPerformance: 85,
        load: minuteLoad(days[30 + i].minuteHr, 56, 185),
        stress: x.minutes,
        naps: [],
      }).current;
    });
    for (const e of ends) {
      expect(e).toBeGreaterThanOrEqual(15);
      expect(e).toBeLessThanOrEqual(40);
    }
  });
});

// ── SCORING_VERSION 21 ─────────────────────────────────────────────────────────────────────────────────────────────
describe("exertion is not stress (version 21)", () => {
  // Resting 55, max 185: 40 % of reserve is 55 + 0.4 × 130 = 107 bpm.
  const exertion = { restingHr: 55, maxHr: 185, workouts: [] as { start: number; end: number }[] };
  const threshold = 55 + stressConfig.exertionShare * 130;

  it("a minute at 40 % of heart-rate reserve is excluded; just below it is scored", () => {
    const r = run({ hr: hrFrom((m) => (m === at(10) ? threshold : m === at(11) ? threshold - 0.5 : 70)), exertion });
    expect(r.minutes[at(10)]).toBeNull();
    expect(r.minutes[at(11)]).not.toBeNull();
  });

  it("a 10-minute exertion run excludes the 30 minutes after it; a 9-minute one does not", () => {
    const ten = run({ hr: hrFrom((m) => (m >= at(14) && m < at(14, 10) ? 130 : 70)), exertion });
    for (let m = at(14, 10); m < at(14, 40); m++) expect(ten.minutes[m]).toBeNull();
    expect(ten.minutes[at(14, 40)]).not.toBeNull();
    const nine = run({ hr: hrFrom((m) => (m >= at(14) && m < at(14, 9) ? 130 : 70)), exertion });
    expect(nine.minutes[at(14, 9)]).not.toBeNull();
  });

  it("a 1-minute dip inside a run doesn't break it", () => {
    const r = run({ hr: hrFrom((m) => (m >= at(14) && m < at(14, 11) && m !== at(14, 5) ? 130 : 70)), exertion });
    expect(r.minutes[at(14, 20)]).toBeNull(); // the run counted as 11 minutes, so the tail applies
  });

  it("a logged workout's end starts a 30-minute tail, however its heart rate looked", () => {
    const w = { start: start + at(18) * 60, end: start + at(18, 45) * 60 };
    const r = run({ excluded: [w], exertion: { ...exertion, workouts: [w] } });
    for (let m = at(18, 45); m < at(19, 15); m++) expect(r.minutes[m]).toBeNull();
    expect(r.minutes[at(19, 15)]).not.toBeNull();
  });

  it("a strong stress response (+22 bpm, far below 40 %) is still scored and reads high", () => {
    const r = run({ hr: hrFrom((m) => (m >= at(10) && m < at(10, 45) ? 92 : 70)), exertion });
    expect(r.minutes[at(10, 20)]).toBeGreaterThanOrEqual(2);
  });

  it("without the exertion input nothing changes (the old behaviour)", () => {
    const hr = hrFrom((m) => (m >= at(14) && m < at(14, 30) ? 130 : 70));
    expect(run({ hr }).minutes[at(14, 5)]).not.toBeNull();
    expect(run({ hr, exertion }).minutes[at(14, 5)]).toBeNull();
  });
});

describe("rollingReference: a slow rise is the day's level, not stress (version 21)", () => {
  const sigma = 4;

  it("hand-computed: a 6-hour +8 bpm rise lifts the reference by (median − reference − σ) = 4", () => {
    const still = Array.from({ length: N }, (_, m) => (m >= at(12) && m < at(18) ? 78 : 70));
    const ref = rollingReference(still, 70, sigma);
    // Before the rise the window's median is 70: the reference stays 70.
    expect(ref[at(12)]).toBe(70);
    // Once more than half of the previous 300 minutes are at 78, the median is 78: 70 + (78 − 70 − 4) = 74.
    expect(ref[at(16)]).toBe(74);
    // A +8 minute then sits only 4 bpm (1σ) above its reference.
    const r = run({ hr: hrFrom((m) => still[m]) });
    expect(r.minutes[at(16)]).toBeLessThan(stressConfig.highFrom);
    expect(r.minutes[at(12, 30)]).toBeGreaterThan(stressConfig.highFrom); // the rise's start still reads high
  });

  it("a 45-minute +14 bpm episode in a calm day leaves the reference unchanged", () => {
    const still = Array.from({ length: N }, (_, m) => (m >= at(14) && m < at(14, 45) ? 84 : 70));
    const ref = rollingReference(still, 70, sigma);
    for (let m = at(14); m < at(16); m++) expect(ref[m]).toBe(70);
  });

  it("uses the baseline reference until 30 still minutes fill the window", () => {
    const still = Array.from({ length: N }, (_, m) => (m >= at(10) ? 90 : null));
    const ref = rollingReference(still, 70, sigma);
    expect(ref[at(10, 29)]).toBe(70);
    expect(ref[at(10, 30)]).toBe(70 + (90 - 70 - sigma));
  });

  it("the incremental window equals a naive sort on random data", () => {
    let x = 7;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648), x / 2147483648);
    const still = Array.from({ length: N }, () => (rnd() < 0.3 ? null : 60 + 30 * rnd()));
    const ref = rollingReference(still, 70, sigma);
    for (let m = 0; m < N; m += 37) {
      const w = still.slice(Math.max(0, m - stressConfig.rollWindowMin), m).filter((v): v is number => v != null).sort((a, b) => a - b);
      const expected = w.length < stressConfig.rollMinStill ? 70 : 70 + Math.max(0, w[Math.floor(w.length / 2)] - 70 - sigma);
      expect(ref[m]).toBeCloseTo(expected, 12);
    }
  });
});

describe("foldableStillMedian: an abnormal day stays out of the baseline (version 21)", () => {
  const steady = Array.from({ length: 30 }, (_, i) => 74 + (i % 3) - 1);
  const b = foldDaytimeBaseline(steady);
  const twoSigma = foldGateSigma * sigma(b);

  it("a day more than 2σ above a usable baseline is left out; one inside is kept", () => {
    expect(foldableStillMedian(steady, b.baseline + twoSigma + 0.1)).toBeNull();
    expect(foldableStillMedian(steady, b.baseline + twoSigma - 0.1)).toBe(b.baseline + twoSigma - 0.1);
    expect(foldableStillMedian(steady, b.baseline - 10)).toBe(b.baseline - 10); // low days fold (the gate is one-sided)
    expect(foldableStillMedian(steady, null)).toBeNull();
  });

  it("with under 7 days of history every day folds, so a new user's baseline can form", () => {
    expect(foldableStillMedian(steady.slice(0, 6), 120)).toBe(120);
  });
});
