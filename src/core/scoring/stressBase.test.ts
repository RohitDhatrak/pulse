import { describe, expect, it } from "vitest";
import { daytimeHRCfg, foldHistory } from "./baselines";
import {
  analyze,
  baselineRelativeHighMarginBPM,
  bucketSeconds,
  cleanEarlyDays,
  dayDaytimeAggregate,
  earlyCleanConfig,
  foldableStillMedian,
  foldDaytimeBaseline,
  gateStillMedian,
  highBandFloor,
  marginToSigma,
  minHourHrSamples,
  type ScoringMode,
  scoringMode,
  noStillGate,
  squash,
  stillGateConfig,
} from "./stressBase";
import type { HrSample } from "./types";

/** One local hour of `n` 1 Hz samples at `bpm`, on day `dayIndex` (UTC). */
const hourHr = (hour: number, bpm: number, n = minHourHrSamples, dayIndex = 0): HrSample[] =>
  Array.from({ length: n }, (_, i) => ({ ts: dayIndex * 86_400 + hour * 3_600 + i, bpm }));
const hours = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const flatDayHr = (dayIndex: number, bpm: number) => hours(8, 17).flatMap((h) => hourHr(h, bpm, minHourHrSamples, dayIndex));
const levelAt = (r: ReturnType<typeof analyze>, hour: number) => r.hours.find((p) => p.hour === hour)?.level;
/** 20 days at 65 bpm fold to a personal daytime-HR baseline of exactly 65. */
const baselineRelative65 = (): ScoringMode => ({ kind: "baselineRelative", hr: foldHistory(Array(20).fill(65), daytimeHRCfg) });

describe("DaytimeStressTest (HR-only)", () => {
  it("hourly levels match the Swift twin oracle", () => {
    // noop's oracle also carries R-R, but at a constant RMSSD every hour, whose zero spread drops the term.
    const hr = hours(7, 11).flatMap((h) => hourHr(h, 60 + (h - 7) * 4));
    const r = analyze(hr);
    expect(r.hours.map((p) => `${p.startTs}:${p.level!.toFixed(6)}`).join(" ")).toBe(
      "25200:0.990715 28800:1.500000 32400:2.009285 36000:2.413289 39600:2.678875",
    );
    expect(r.highStressMinutes).toBe(180);
    expect(r.sustainedHigh).toBe(true);
    expect(r.sustainedRun).toBe(3);
    expect(r.peak?.startTs).toBe(39600);
  });

  it("sleep hours in the window do not shift the waking timeline", () => {
    const wakingBpm = [62, 64, 63, 65, 64, 63, 62, 64, 66, 63, 64, 65];
    const waking = hours(6, 17).flatMap((h, i) => hourHr(h, wakingBpm[i]));
    const sleep = hours(0, 5).flatMap((h, i) => hourHr(h, [50, 51, 52, 51, 50, 53][i]));
    const wakingOnly = analyze(waking);
    const withSleep = analyze([...sleep, ...waking]);
    expect(withSleep.sustainedHigh).toBe(wakingOnly.sustainedHigh);
    for (const h of hours(6, 17)) {
      expect(levelAt(withSleep, h)).not.toBeNull();
      expect(levelAt(withSleep, h)).toBeCloseTo(levelAt(wakingOnly, h)!, 9);
    }
    expect(withSleep.sustainedHigh).toBe(false);
  });

  it("dayRelative default equals the explicit mode", () => {
    const hr = [...[8, 9, 10].flatMap((h) => hourHr(h, 58)), ...hourHr(13, 120), ...hourHr(14, 125), ...hourHr(15, 130)];
    expect(analyze(hr, 3_600)).toEqual(analyze(hr, 3_600, { kind: "dayRelative" }));
  });

  it("highStressMinutes counts every high hour, not just the trailing run", () => {
    const hr = [...hourHr(7, 130), ...[8, 9, 10, 11].flatMap((h) => hourHr(h, 60))];
    const r = analyze(hr);
    expect(r.sustainedHigh).toBe(false);
    const highHours = r.hours.filter((p) => p.level! >= highBandFloor).length;
    expect(highHours).toBeGreaterThan(0);
    expect(r.highStressMinutes).toBe(highHours * (bucketSeconds / 60));
  });

  it("an under-gate hour is listed but unscored", () => {
    const r = analyze([...hourHr(9, 70), ...hourHr(10, 70, minHourHrSamples - 1)]);
    expect(levelAt(r, 10)).toBeNull();
    expect(r.hours.find((p) => p.hour === 10)?.meanHr).toBeNull();
  });

  it("marginToSigma lands exactly on the band", () => {
    const sd = marginToSigma(baselineRelativeHighMarginBPM, highBandFloor);
    expect(squash(baselineRelativeHighMarginBPM / sd)).toBeCloseTo(highBandFloor, 9);
  });

  it("baselineRelative recovers multiple injected elevations", () => {
    const mode = baselineRelative65();
    expect(mode.kind === "baselineRelative" && mode.hr.baseline).toBeCloseTo(65, 6);
    const levels: [number, number][] = [
      [8, 65],
      [10, 72],
      [13, 80],
      [16, 95],
    ];
    const r = analyze(levels.flatMap(([h, bpm]) => hourHr(h, bpm)), 0, mode);
    const scores = levels.map(([h]) => levelAt(r, h)!);
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeGreaterThan(scores[i - 1]);
    expect(scores[0]).toBeCloseTo(1.5, 1);
    expect(Math.abs(scores[2] - highBandFloor)).toBeLessThan(0.01);
    expect(scores[3]).toBeGreaterThan(highBandFloor);
  });

  it("baselineRelative calm day at the personal baseline reads 1.5", () => {
    const r = analyze([8, 10, 13, 16].flatMap((h) => hourHr(h, 65)), 0, baselineRelative65());
    for (const p of r.hours) expect(Math.abs(p.level! - 1.5)).toBeLessThan(0.05);
    expect(r.highStressMinutes).toBe(0);
    expect(r.sustainedHigh).toBe(false);
  });

  it("baselineRelative elevated day produces high-stress minutes", () => {
    const r = analyze(hours(8, 16).flatMap((h) => hourHr(h, 95)), 0, baselineRelative65());
    expect(r.highStressMinutes).toBeGreaterThan(0);
    for (const p of r.hours) expect(p.level!).toBeGreaterThanOrEqual(highBandFloor);
  });

  it("empty HR is the empty read", () => {
    expect(analyze([])).toEqual({ hours: [], sustainedHigh: false, sustainedRun: 0, dayMean: null, peak: null, highStressMinutes: 0 });
  });
});

describe("DaytimeBaselinesTest (HR-only)", () => {
  const spread = [60, 62, 64, 66, 68, 70, 72, 74, 76, 78];
  const spreadDay = () => hours(8, 17).flatMap((h, i) => hourHr(h, spread[i]));

  it("day aggregate is P10 of waking-hour mean HRs", () => {
    expect(dayDaytimeAggregate(spreadDay())).toBeCloseTo(61.8, 6);
  });

  it("day aggregate applies the scorer's min-samples gate", () => {
    const withSparse = dayDaytimeAggregate([...spreadDay(), ...hourHr(7, 40, minHourHrSamples - 1)]);
    expect(withSparse).toBeCloseTo(dayDaytimeAggregate(spreadDay())!, 9);
  });

  it("day aggregate excludes non-waking hours", () => {
    expect(dayDaytimeAggregate([...spreadDay(), ...hourHr(3, 45)])).toBeCloseTo(61.8, 6);
  });

  it("fold converges to the personal daytime floor", () => {
    const b = foldDaytimeBaseline(hours(0, 11).map((d) => dayDaytimeAggregate(flatDayHr(d, 65))));
    expect(b.baseline).toBeCloseTo(65, 6);
    expect(b.status === "provisional" || b.status === "trusted").toBe(true);
  });

  it("scoringMode falls back to dayRelative on cold start and sparse history", () => {
    expect(scoringMode([]).kind).toBe("dayRelative");
    expect(scoringMode(hours(0, 2).map((d) => dayDaytimeAggregate(flatDayHr(d, 65)))).kind).toBe("dayRelative");
  });

  it("scoringMode uses baselineRelative once history is usable", () => {
    const mode = scoringMode(hours(0, 5).map((d) => dayDaytimeAggregate(flatDayHr(d, 65))));
    expect(mode.kind).toBe("baselineRelative");
    if (mode.kind === "baselineRelative") expect(mode.hr.baseline).toBeCloseTo(65, 6);
  });

  it("folded baseline scores an all-day elevation against the personal floor", () => {
    const mode = scoringMode(hours(0, 19).map((d) => dayDaytimeAggregate(flatDayHr(d, 65))));
    expect(mode.kind).toBe("baselineRelative");
    const r = analyze(flatDayHr(0, 80), 0, mode);
    expect(r.hours.length).toBeGreaterThan(0);
    expect(r.highStressMinutes).toBeGreaterThan(0);
    for (const p of r.hours) expect(p.level!).toBeGreaterThanOrEqual(highBandFloor - 0.05);
  });

  it("folded baseline calm day at the floor reads neutral", () => {
    const mode = scoringMode(hours(0, 19).map((d) => dayDaytimeAggregate(flatDayHr(d, 65))));
    const r = analyze(flatDayHr(0, 65), 0, mode);
    expect(r.highStressMinutes).toBe(0);
    for (const p of r.hours) expect(Math.abs(p.level! - 1.5)).toBeLessThan(0.05);
  });

  it("an empty day reduces to nothing", () => {
    expect(dayDaytimeAggregate([])).toBeNull();
  });
});

describe("the baseline's gate releases a new normal (SCORING_VERSION 50)", () => {
  const usual = Array.from({ length: 28 }, (_, i) => 70 + (i % 3) - 1);
  /** Feed values through the gate as scoreStress does; returns the history, the gate and each day's result. */
  function feed(values: (number | null)[], held: (i: number) => boolean = () => false, start = usual) {
    const history: (number | null)[] = [...start];
    let gate = noStillGate;
    const out = values.map((v, i) => {
      const g = gateStillMedian(history, v, gate, held(i));
      for (const b of g.backfill) history[b.index] = b.value;
      history.push(g.fold);
      gate = g.gate;
      return g;
    });
    return { history, gate, out };
  }
  const k = stillGateConfig.release;

  it("a day under the gate folds and ends a run", () => {
    const { out } = feed([90, 90, 71]);
    expect(out.map((g) => g.fold)).toEqual([null, null, 71]);
    expect(out[2].gate.run).toEqual([]);
  });

  it(`gated for ${k - 1} days in a row; on day ${k} the run is a new normal: it folds and the earlier days are written back`, () => {
    const { history, out } = feed(Array(k).fill(90));
    expect(out.slice(0, k - 1).every((g) => g.fold === null && g.backfill.length === 0)).toBe(true);
    expect(out[k - 1].fold).toBe(90);
    expect(out[k - 1].backfill).toEqual(Array.from({ length: k - 1 }, (_, i) => ({ index: usual.length + i, value: 90 })));
    expect(history.slice(usual.length)).toEqual(Array(k).fill(90));
    // Version 49 (the gate alone) kept all of them out.
    expect(Array(k).fill(90).map(() => foldableStillMedian([...usual], 90))).toEqual(Array(k).fill(null));
  });

  it("past the release each gated day folds, without another backfill, until one is back under the gate", () => {
    const { out } = feed([...Array(k + 2).fill(95), 71, 95]);
    // Once released, the baseline restarts towards 95, so later 95s may fall under the gate; either way they fold.
    expect(out.slice(k - 1, k + 2).every((g) => g.fold === 95)).toBe(true);
    expect(out.slice(k, k + 2).every((g) => g.backfill.length === 0)).toBe(true);
    expect(out[k + 2]).toMatchObject({ fold: 71, gate: { run: [] } });
  });

  it("a night on Recovery's illness hold stays out without counting or ending the run; so does a missing day", () => {
    const values = [90, 90, 90, null, 90, 90, 90, 90];
    const { out } = feed(values, (i) => i === 4);
    expect(out[3]).toMatchObject({ fold: null, backfill: [] });
    expect(out[4]).toMatchObject({ fold: null, backfill: [] });
    expect(out[4].gate.run).toHaveLength(3);
    // Days 0, 1, 2, 5, 6, 7 are six gated days that count: one short of the release.
    expect(out.every((g) => g.fold === null)).toBe(true);
    expect(out.at(-1)!.gate.run.map((r) => r.value)).toEqual([90, 90, 90, 90, 90, 90]);
  });

  it("with fewer than 7 days behind it the gate is off: everything folds", () => {
    expect(feed([95, 95], () => false, [70, 71]).out.map((g) => g.fold)).toEqual([95, 95]);
  });

  it("an illness week held from its second night stays out however long it lasts", () => {
    const { out, history } = feed(Array(14).fill(90), (i) => i >= 1);
    expect(out.every((g) => g.fold === null)).toBe(true);
    expect(foldDaytimeBaseline(history).baseline).toBeCloseTo(foldDaytimeBaseline(usual).baseline, 6);
  });
});

describe("an atypical first week (SCORING_VERSION 52)", () => {
  const sick = Array(5).fill(90);
  const usual = (n: number) => Array.from({ length: n }, (_, i) => 70 + (i % 3) - 1);
  const W = earlyCleanConfig.days;

  it("5 sick days then 6 ordinary ones: the sick days are left out, and the baseline is the ordinary level (version 51: 90, the ordinary days rejected)", () => {
    const h = [...sick, ...usual(6)];
    expect(cleanEarlyDays(h)).toEqual([...Array(5).fill(null), ...usual(6)]);
    expect(foldDaytimeBaseline(h).baseline).toBeCloseTo(70, 0);
    expect(foldHistory(h, daytimeHRCfg).baseline).toBeGreaterThan(85);
  });

  it("while the sick days are still the majority nothing tells which week is ordinary: the 4 ordinary days are the ones out", () => {
    expect(cleanEarlyDays([...sick, ...usual(4)])).toEqual([...sick, null, null, null, null]);
  });

  it("two-sided: a day 10 bpm below the rest is left out", () => {
    const h = [...usual(8), 60, ...usual(3)];
    expect(cleanEarlyDays(h)[8]).toBeNull();
    expect(cleanEarlyDays(h).filter((v) => v == null)).toHaveLength(1);
  });

  it("an ordinary start is untouched, and so are fewer than 7 days", () => {
    const noisy = [70, 72, 68, 71, 69, 73, 67, 70, 72, 68, 71, 69, 70];
    expect(cleanEarlyDays(noisy)).toBe(noisy);
    expect(cleanEarlyDays([90, 90, 90, 70, 70, 70])).toEqual([90, 90, 90, 70, 70, 70]);
  });

  it(`only the first ${W} days are judged; a sick block after them is left to the gate`, () => {
    const h = [...usual(W), ...Array(10).fill(95)];
    expect(cleanEarlyDays(h)).toBe(h);
    const early = [...sick, ...usual(W - 5), 90, 90];
    expect(cleanEarlyDays(early).slice(W)).toEqual([90, 90]);
  });
});
