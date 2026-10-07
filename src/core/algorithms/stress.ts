// Own algorithm (docs/algorithms/stress.md): the Stress Monitor. Each still, awake minute's mean HR is
// z-scored against a personal daytime baseline folded as noop's DaytimeBaselines does (foldDaytimeBaseline),
// then mapped onto 0–3 with our own logistic. Minutes with steps nearby, workouts and sleep are excluded rather
// than guessed. Since SCORING_VERSION 13 the baseline folds each day's *median* still-minute HR (your usual still
// level, not your calmest hour), a minute at it reads 0.4, and "high" needs 2 minutes in a row: simulated calm desk
// days read about half as many high minutes while a real 30-minute episode is still caught.
import { isUsable, sigma } from "../scoring/baselines";
import {
  daytimeHRAggregatePercentile,
  isWakingHourOfDay,
  quantile,
} from "../scoring/stressBase";
import type { BaselineState, HrSample } from "../scoring/types";

export const stressConfig = {
  /** Logistic slope (*tunable*). */
  k: 1.5,
  /** z at the curve's midpoint (*tunable*): ln(6.5) / 1.5 ≈ 1.25, so a minute at your usual still level reads 0.4. */
  z0: Math.log(6.5) / 1.5,
  /** A minute is still when it and the minutes this far either side have 0 steps (spec). */
  stillWindowMin: 2,
  /** Low is below this (spec). */
  mediumFrom: 1,
  /** High is at or above this (spec). */
  highFrom: 2,
  /** A minute counts as high only inside a run of at least this many consecutive scored high minutes. */
  minHighRunMin: 2,
  /** Waking still minutes needed for a day's median still HR. */
  minMedianMinutes: 60,
  /** A waking hour joins the day's aggregate with at least this many still minutes with HR (*tunable*). */
  minHourStillMinutes: 15,
  /** σ in bpm while the personal baseline is not usable: noop's fixed σ (+15 bpm squashes to 2.0). */
  // Puts baseline + 15 bpm at stress 2.0 on our curve (z ≈ 1.96), noop's fixed-σ intent.
  fallbackSigmaBpm: 15 / 1.96,
};

/** [start, end) in unix seconds. */
export interface Interval {
  start: number;
  end: number;
}

/** Mean HR of each minute [start + 60m, start + 60m + 60), or null without a sample. */
export function minuteMeanHr(hr: HrSample[], start: number, end: number): (number | null)[] {
  const n = Math.max(0, Math.round((end - start) / 60));
  const sum = new Float64Array(n);
  const count = new Uint32Array(n);
  for (const s of hr) {
    const m = Math.floor((s.ts - start) / 60);
    if (m < 0 || m >= n) continue;
    sum[m] += s.bpm;
    count[m]++;
  }
  return Array.from(sum, (v, m) => (count[m] ? v / count[m] : null));
}

/** 3 / (1 + e^(−k(z − z0))): on (0, 3). */
export const stressLevel = (z: number): number => 3 / (1 + Math.exp(-stressConfig.k * (z - stressConfig.z0)));

export interface StressInput {
  /** Local midnight that starts the day, unix seconds. Minute m starts at start + 60m. */
  start: number;
  /** Next local midnight, so DST days have 1,380 or 1,500 minutes. */
  end: number;
  hr: HrSample[];
  /** Steps per minute, indexed like the minute grid. Missing entries count as 0. */
  steps: ArrayLike<number | undefined>;
  /** Workouts and every sleep session (main and naps) touching the day. */
  excluded: Interval[];
  /** foldDaytimeBaseline over the prior days' `stillMedianHr` values, oldest first, today excluded. */
  baseline: BaselineState;
}

export interface StressResult {
  /** 0–3 per minute of the grid, or null when not scored (no HR, moving, workout or sleep). */
  minutes: (number | null)[];
  /** Mean of the scored minutes in each hour since `start`, or null. */
  hourly: (number | null)[];
  lowMin: number;
  mediumMin: number;
  highMin: number;
  /** Mean over scored minutes, or null with none. */
  average: number | null;
  /** True while the personal baseline is not usable and σ is the fixed fallback. */
  provisional: boolean;
  referenceHr: number | null;
  sigmaBpm: number;
  /**
   * Today's resting daytime HR: P10 of the waking hours' (06–22 local) still-minute mean HR, or null.
   * Fold it into later days' baselines.
   */
  dayAggregate: number | null;
  /** Median HR of today's still minutes in waking hours (06–22 local), or null under `minMedianMinutes`. */
  stillMedianHr: number | null;
}

export function stress(input: StressInput): StressResult {
  const { start, end, hr, steps, excluded, baseline } = input;
  const c = stressConfig;
  const means = minuteMeanHr(hr, start, end);
  const n = means.length;
  const provisional = !isUsable(baseline);
  const sigmaBpm = provisional ? c.fallbackSigmaBpm : sigma(baseline);
  const blocked = new Uint8Array(n);
  for (const { start: s, end: e } of excluded) {
    // Minute m overlaps [s, e) when start + 60m < e and start + 60m + 60 > s.
    for (let m = Math.max(0, Math.floor((s - start) / 60)); m < Math.min(n, Math.ceil((e - start) / 60)); m++) blocked[m] = 1;
  }
  for (let m = 0; m < n; m++) {
    if (!steps[m]) continue;
    for (let j = Math.max(0, m - c.stillWindowMin); j <= Math.min(n - 1, m + c.stillWindowMin); j++) blocked[j] = 1;
  }

  const still = means.map((bpm, m) => (bpm == null || blocked[m] ? null : bpm));

  // ponytail: hour = minutes since local midnight / 60, so on a DST day the hours after the change are off by one.
  const hourMeans: number[] = [];
  for (let h = 0; h * 60 < n; h++) {
    const xs = still.slice(h * 60, h * 60 + 60).filter((v): v is number => v != null);
    if (isWakingHourOfDay(h) && xs.length >= c.minHourStillMinutes) hourMeans.push(meanOf(xs)!);
  }
  const dayAggregate = hourMeans.length ? quantile(hourMeans.sort((a, b) => a - b), daytimeHRAggregatePercentile) : null;
  const waking = still.filter((v, m): v is number => v != null && isWakingHourOfDay(Math.floor(m / 60)));
  const stillMedianHr = waking.length >= c.minMedianMinutes ? quantile(waking.sort((a, b) => a - b), 0.5) : null;
  // A baseline with no accepted day holds a placeholder centre; use today's own median instead.
  const referenceHr = baseline.nValid > 0 ? baseline.baseline : stillMedianHr;

  const minutes = demoteShortHighRuns(
    still.map((bpm) => (bpm == null || referenceHr == null ? null : stressLevel((bpm - referenceHr) / sigmaBpm))),
  );
  const hourly: (number | null)[] = [];
  for (let h = 0; h * 60 < n; h++) hourly.push(meanOf(minutes.slice(h * 60, h * 60 + 60)));
  const scored = minutes.filter((v): v is number => v != null);
  return {
    minutes,
    hourly,
    lowMin: scored.filter((v) => v < c.mediumFrom).length,
    mediumMin: scored.filter((v) => v >= c.mediumFrom && v < c.highFrom).length,
    highMin: scored.filter((v) => v >= c.highFrom).length,
    average: meanOf(scored),
    provisional,
    referenceHr,
    sigmaBpm,
    dayAggregate,
    stillMedianHr,
  };
}

/**
 * A high minute outside a run of at least `minHighRunMin` consecutive scored high minutes becomes medium
 * (`highFrom − 0.01`), so one-minute spikes don't count. An unscored minute breaks a run.
 */
export function demoteShortHighRuns(minutes: (number | null)[]): (number | null)[] {
  const { highFrom, minHighRunMin } = stressConfig;
  const out = minutes.slice();
  for (let m = 0; m < out.length; ) {
    if (out[m] == null || out[m]! < highFrom) {
      m++;
      continue;
    }
    let end = m;
    while (end < out.length && out[end] != null && out[end]! >= highFrom) end++;
    if (end - m < minHighRunMin) for (let j = m; j < end; j++) out[j] = highFrom - 0.01;
    m = end;
  }
  return out;
}

function meanOf(xs: (number | null)[]): number | null {
  let sum = 0;
  let count = 0;
  for (const x of xs) {
    if (x == null) continue;
    sum += x;
    count++;
  }
  return count ? sum / count : null;
}
