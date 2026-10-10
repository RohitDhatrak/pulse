// Ports SleepStager.hypnogramMetrics (SleepStager.kt), RestScorer (AnalyticsEngine.kt L1505–1739: sleep
// performance and need), SleepDebt.kt, and VitalityEngine.sleepConsistency (1 − CV). Rest's consistency input
// is a plain [0, 1] number so U7 can pass SRI / 100 in its place.
import type { HypnogramMetrics, SleepSession, Stage, StageSegment } from "./types";

// ── Hypnogram ──────────────────────────────────────────────────────────────

const isWake = (stage: Stage): boolean => {
  const s = stage.trim().toLowerCase();
  return s === "wake" || s === "awake";
};

/** AASM-style aggregates from a session's stage segments. */
export function hypnogramMetrics(session: SleepSession): HypnogramMetrics {
  const segs = [...session.stages].sort((a, b) => a.start - b.start);
  const tib = Math.max(0.0, session.end - session.start);
  const dur = (s: StageSegment) => s.end - s.start;
  const sum = (stage: Stage) => segs.filter((s) => s.stage === stage).reduce((a, s) => a + dur(s), 0);
  const sleepSegs = segs.filter((s) => s.stage === "light" || s.stage === "deep" || s.stage === "rem");
  const tst = sleepSegs.reduce((a, s) => a + dur(s), 0);
  const deepS = sum("deep");
  const remS = sum("rem");
  const lightS = sum("light");

  const first = sleepSegs[0];
  const last = sleepSegs.at(-1);
  const onset = first && last ? first.start : session.end;
  const sptEnd = first && last ? last.end : session.end;
  const sol = first && last ? Math.max(0.0, onset - session.start) : tib;

  const firstRem = segs.find((s) => s.stage === "rem");
  const remLatency = firstRem ? firstRem.start - onset : null;

  let waso = 0.0;
  let disturbances = 0;
  for (const s of segs) {
    if (!isWake(s.stage)) continue;
    const w0 = Math.max(s.start, onset);
    const w1 = Math.min(s.end, sptEnd);
    if (w1 > w0) {
      waso += w1 - w0;
      disturbances += 1;
    }
  }

  const pct = (x: number) => (tst > 0 ? (x / tst) * 100.0 : 0.0);
  return {
    tibS: tib,
    tstS: tst,
    sptS: Math.max(0.0, sptEnd - onset),
    solS: sol,
    remLatencyS: remLatency,
    wasoS: waso,
    efficiency: Math.min(1.0, tib > 0 ? tst / tib : 0.0),
    disturbances,
    deepMin: deepS / 60.0,
    remMin: remS / 60.0,
    lightMin: lightS / 60.0,
    deepPct: pct(deepS),
    remPct: pct(remS),
    lightPct: pct(lightS),
  };
}

// ── Rest (sleep performance) ───────────────────────────────────────────────

export const wDuration = 0.5;
export const wEfficiency = 0.2;
export const wRestorative = 0.2;
export const wConsistency = 0.1;
/**
 * Need before 7 nights (SCORING_VERSION 15; was 8.0): the middle of the adult 7–8 h band. It is also the default
 * argument of rest(), ledger() and the forecast, but the pipeline always passes a personal need.
 */
export const defaultSleepNeedHours = 7.5;
/** Fewer scorable nights than this → the population default need. */
export const minNeedNights = 7;
/** Quantile of recent nights taken as the need (SCORING_VERSION 15; was 0.75). See docs/algorithms/sleep-need.md. */
export const needQuantile = 0.5;
export const maxNeedHours = 9.5;
export const restorativeTargetShare = 0.5;
export const deepShareTarget = 0.13;
export const deepFloorFactor = 0.5;
/** Used when no consistency signal is supplied (noop adds a neutral term, it does not renormalize). */
export const NEUTRAL_CONSISTENCY = 0.5;
/**
 * A night without sleep stages (SCORING_VERSION 31) is scored with the median restorative component of the last
 * `usualRestorativeNights` staged main sleeps, given at least `minUsualRestorativeNights`; with fewer, the restorative
 * weight is left out and the rest renormalised. Scoring deep and REM as 0 cost 9–16 points; renormalising credited
 * older people with a young person's restorative sleep (+9); your own median was within 0.3 on average
 * (docs/algorithms/sleep-need.md § Why version 31).
 */
export const usualRestorativeNights = 28;
export const minUsualRestorativeNights = 5;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Population floor on the need, in hours *asleep*: 7 for adults (the lower bound of the AASM / NSF 7–9 h range;
 * SCORING_VERSION 15, was 8, which gave every healthy 7 h sleeper 73 min of permanent debt), 9 under 18.
 */
export function populationNeedFloorHours(age: number | null): number {
  if (age == null || age <= 0) return 7.0;
  return age < 18 ? 9.0 : 7.0;
}

/**
 * The median of the recent nights (needQuantile), floored at the population target and capped at maxNeedHours.
 * The median, not the upper quartile: the 75th percentile kept anyone whose sleep varies short of their own better
 * nights, and let a sick or catch-up week raise the next month's need.
 */
export function personalizedNeedHours(nightlyHours: number[], age: number | null): number {
  const floor = populationNeedFloorHours(age);
  const xs = nightlyHours.filter((h) => h > 0.0).sort((a, b) => a - b);
  if (xs.length < minNeedNights) return Math.min(Math.max(defaultSleepNeedHours, floor), maxNeedHours);
  const pos = needQuantile * (xs.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, xs.length - 1);
  const q = xs[lo] + (pos - lo) * (xs[hi] - xs[lo]);
  return Math.min(Math.max(q, floor), maxNeedHours);
}

/** The restorative component, 0–100: (deep + REM) share against 50 %, scaled down when deep is under 13 %. */
export function restorativeScore(deepSeconds: number, remSeconds: number, asleepSeconds: number): number {
  const restorativeShare = (deepSeconds + remSeconds) / asleepSeconds;
  const deepAdequacy = clamp(deepSeconds / asleepSeconds / deepShareTarget, 0.0, 1.0);
  const deepFactor = deepFloorFactor + (1.0 - deepFloorFactor) * deepAdequacy;
  return Math.min(100.0, (restorativeShare / restorativeTargetShare) * 100.0) * deepFactor;
}

/**
 * Rest composite in [0, 100] (2 dp), or null with no asleep time.
 * @param efficiency asleep / in-bed in [0, 1].
 * @param deepSeconds, remSeconds null when the night has no stages (version 31): the restorative component is then
 * `opts.usualRestorative` if given, else left out and the other weights renormalised.
 * @param consistency sleep regularity in [0, 1]; null → NEUTRAL_CONSISTENCY.
 */
export function rest(
  asleepSeconds: number,
  efficiency: number,
  deepSeconds: number | null,
  remSeconds: number | null,
  sleepNeedHours: number | null = null,
  consistency: number | null = null,
  opts: { usualRestorative?: number | null } = {},
): number | null {
  if (asleepSeconds <= 0.0) return null;
  const asleepHours = asleepSeconds / 3600.0;
  const needHours = Math.max(sleepNeedHours ?? defaultSleepNeedHours, 0.1);
  const durationScore = Math.min(100.0, (asleepHours / needHours) * 100.0);
  const efficiencyScore = clamp(efficiency * 100.0, 0.0, 100.0);
  const consistencyScore = clamp((consistency ?? NEUTRAL_CONSISTENCY) * 100.0, 0.0, 100.0);
  const restorative =
    deepSeconds != null && remSeconds != null ? restorativeScore(deepSeconds, remSeconds, asleepSeconds) : (opts.usualRestorative ?? null);
  // The same order of terms as before version 31, so a staged night scores to the bit as it did.
  const weighted =
    restorative != null
      ? wDuration * durationScore + wEfficiency * efficiencyScore + wRestorative * restorative + wConsistency * consistencyScore
      : (wDuration * durationScore + wEfficiency * efficiencyScore + wConsistency * consistencyScore) / (wDuration + wEfficiency + wConsistency);
  return Math.round(weighted * 100.0) / 100.0;
}

/** Rest from a night's stored totals (noop's restFromDaily, at the default need). */
export function restFromTotals(
  night: { totalSleepMin: number | null; efficiency: number | null; deepMin: number | null; remMin: number | null },
  consistency: number | null = null,
): number | null {
  const { totalSleepMin, efficiency } = night;
  if (totalSleepMin == null || efficiency == null || totalSleepMin <= 0.0) return null;
  return rest(totalSleepMin * 60.0, efficiency, (night.deepMin ?? 0.0) * 60.0, (night.remMin ?? 0.0) * 60.0, null, consistency);
}

/**
 * 1 − coefficient of variation of nightly sleep hours, clamped to [0, 1]; null under 3 nights.
 * noop passes the trailing 28 nights.
 */
export function sleepConsistency(nightlyHours: number[]): number | null {
  const xs = nightlyHours.filter((h) => h > 0);
  if (xs.length < 3) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (mean <= 0) return null;
  const variance = xs.reduce((a, x) => a + (x - mean) * (x - mean), 0) / xs.length;
  return clamp(1 - Math.sqrt(variance) / mean, 0.0, 1.0);
}

// ── Sleep debt ─────────────────────────────────────────────────────────────

export const DEFAULT_WINDOW_NIGHTS = 14;
/** Calculated debt below this clears; exactly 10 remains. */
export const ON_TARGET_BAND_MIN = 10.0;
export const DEBT_CARRY = 0.55;

export interface SleepDebtNight {
  day: string;
  sleptMin: number;
  /** sleptMin − needMin; positive = surplus. */
  deltaMin: number;
}

export interface SleepDebtLedger {
  /** Never positive. */
  balanceMin: number;
  /** Oldest → newest; skipped nights absent. */
  nights: SleepDebtNight[];
  needMin: number;
  nightCount: number;
  isDebt: boolean;
  magnitudeMin: number;
}

/**
 * Main-night minutes plus nap credit; null without a usable main sleep. Since SCORING_VERSION 25 a night spent awake
 * (`awakeAllNight`) is a measured 0 plus the naps, so the ledger counts it.
 */
export function creditedSleepMin(mainSleepMin: number | null, napSleepMin = 0.0, opts: { awakeAllNight?: boolean } = {}): number | null {
  if (mainSleepMin == null && opts.awakeAllNight) return Math.max(napSleepMin, 0.0);
  if (mainSleepMin == null || !(mainSleepMin > 0.0)) return null;
  return mainSleepMin + Math.max(napSleepMin, 0.0);
}

// ── A night spent awake (SCORING_VERSION 25) ─────────────────────────────────

/**
 * A night with no sleep session is usually a night without data: the band was off, the session hasn't synced, or
 * Fitbit missed it. Counting those as 0 h would invent hours of debt, so a night counts as spent awake only with
 * positive evidence over its core, 00:00–06:00: the band worn, heart rate above resting, and some steps. Assumption-
 * based (docs/algorithms/sleep-need.md § A night spent awake): on simulated nights no sleeping night passes, fever
 * included, and 88 % of nights awake at a desk do.
 */
export const allNighterConfig = {
  /** Local minutes of the night's core, from midnight. */
  nightMinutes: 360,
  /** Minutes of the core with heart rate: the band was worn. */
  wornMin: 300,
  /** The core's median minute HR is at least this far above resting HR, bpm. */
  hrAboveRest: 5,
  /** Steps in the core: someone up and about, not lying in bed. */
  minSteps: 100,
};

export interface NightSummary {
  /** Minutes of 00:00–06:00 with heart rate. */
  hrMinutes: number;
  /** Median of those minutes' mean HR, or null without any. */
  medianHr: number | null;
  steps: number;
}

/** 00:00–06:00 of a day from its per-minute mean HR (null = no HR) and per-minute steps, both from local midnight. */
export function nightSummary(minuteHr: (number | null)[], minuteSteps: number[]): NightSummary {
  const n = allNighterConfig.nightMinutes;
  const hr = minuteHr.slice(0, n).filter((v): v is number => v != null).sort((a, b) => a - b);
  const mid = hr.length >> 1;
  return {
    hrMinutes: hr.length,
    medianHr: hr.length === 0 ? null : hr.length % 2 ? hr[mid] : (hr[mid - 1] + hr[mid]) / 2,
    steps: minuteSteps.slice(0, n).reduce((a, b) => a + b, 0),
  };
}

/**
 * True when the night was spent awake: no sleep session of any kind touched 00:00–06:00, the band was worn for most
 * of it, the median HR sat at least `hrAboveRest` above resting, and there were steps.
 */
export function awakeAllNight(a: { night: NightSummary | null | undefined; restingHr: number | null; sessionOverlapsNight: boolean }): boolean {
  const c = allNighterConfig;
  const n = a.night;
  if (a.sessionOverlapsNight || !n || a.restingHr == null || n.medianHr == null) return false;
  return n.hrMinutes >= c.wornMin && n.medianHr >= a.restingHr + c.hrAboveRest && n.steps >= c.minSteps;
}

/** Half-away-from-zero to 1 dp. */
export function round1(v: number): number {
  const scaled = v * 10.0;
  return (scaled < 0.0 ? Math.ceil(scaled - 0.5) : Math.floor(scaled + 0.5)) / 10.0;
}

const nextDebt = (needMin: number, currentDebt: number, sleptMin: number): number => {
  const calculated = DEBT_CARRY * Math.max(needMin + currentDebt - sleptMin, 0.0);
  return calculated < ON_TARGET_BAND_MIN ? 0.0 : calculated;
};

/**
 * Ledger over the most recent `window` nights with usable sleep, from chronological `[day, totalSleepMin]`
 * rows. Each night: debt = 0.55 × max(0, need + debt − slept). null is a night without data and is skipped; since
 * SCORING_VERSION 25 a 0 is a measured night without sleep and counts (noop skipped 0 too; Pulse never passes 0
 * for missing data).
 */
export function ledger(
  series: [string, number | null][],
  needHours = defaultSleepNeedHours,
  window = DEFAULT_WINDOW_NIGHTS,
): SleepDebtLedger {
  const needMin = Math.max(needHours, 0.0) * 60.0;
  const cap = Math.max(window, 1);
  const windowed = series.filter(([, slept]) => slept != null && slept >= 0.0).slice(-cap);
  const nights: SleepDebtNight[] = [];
  let debt = 0.0;
  for (const [day, slept] of windowed) {
    const sleptMin = slept ?? 0.0;
    debt = nextDebt(needMin, debt, sleptMin);
    nights.push({ day, sleptMin, deltaMin: sleptMin - needMin });
  }
  const balanceMin = -round1(debt);
  return { balanceMin, nights, needMin, nightCount: nights.length, isDebt: balanceMin < 0.0, magnitudeMin: Math.abs(balanceMin) };
}

/** Per-day debt magnitude, oldest → newest; an imported value wins verbatim for its own day. */
export function debtSeries(
  series: [string, number | null][],
  needHours = defaultSleepNeedHours,
  importedDebtMin: Map<string, number> = new Map(),
  window = DEFAULT_WINDOW_NIGHTS,
): [string, number][] {
  const cap = Math.max(window, 1);
  const usable: [string, number | null][] = [];
  const result: [string, number][] = [];
  for (const [day, slept] of series) {
    const imported = importedDebtMin.get(day);
    const sleptMin = slept != null && slept >= 0.0 ? slept : null;
    if (sleptMin != null) {
      usable.push([day, sleptMin]);
      if (usable.length > cap) usable.shift();
    }
    if (imported != null) result.push([day, imported]);
    else if (sleptMin != null) result.push([day, ledger(usable, needHours, cap).magnitudeMin]);
  }
  return result;
}
