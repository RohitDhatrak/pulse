// Ports RecoveryForecast.kt: an evening estimate of tomorrow-morning Recovery from the recent Recovery mean
// plus nudges for today's strain and the sleep you're likely to get, with a ± band. APPROXIMATE.
// Deliberate diff (SCORING_VERSION 12): the strain nudge is one-sided, −3 per Day Strain point today goes above your
// typical training session (capped at −12). noop's two-sided "Effort vs the 14-day average" gave every rest day and
// every not-yet-trained morning +12, and made seed forecasts worse (docs/algorithms/recovery-forecast.md).
// Deliberate diff (SCORING_VERSION 38): the centre is your long-run level plus persistence, not the 14-day mean minus its
// slope. That trend term pushed a lagging mean further from where you were: 30 points too high during an illness and
// 34 too low the week after, and no better than a constant 58 overall (docs/algorithms/recovery-forecast.md).
// Deliberate diff (SCORING_VERSION 38, audit R9): the sleep nudge is what Recovery's own sleep term would add if tonight
// goes like your last 3 nights. It compared the Sleep Planner's advice with your need, so sleep debt (which raises the
// advice) raised the forecast and a nap (which lowers it) lowered it.
import { strainPointsAbove } from "./load";
import { logisticK, logisticScore, logisticZ0, personalSleepCentre, populationMean, sleepPerfScale, wSleep } from "./recovery";
import type { ScoreConfidence } from "./types";

export const baselineWindow = 14;
export const minBaselineNights = 5;
/** Recovery points off tomorrow per Day Strain point today goes above your typical session (*tunable*; uncalibrated). */
export const strainPointsPerRecovery = 3.0;
export const strainAdjCap = 12.0;
/**
 * Version 38: tonight's Sleep Performance is expected to be the mean of your last `sleepRecentNights` (*tunable*); the
 * nudge needs at least `minSleepNights` of them, and your usual night (personalSleepCentre) behind it. 3 nights tracked
 * a bad week best on simulated people (forecast error 18.35 → 18.33 in poor-sleep weeks; 7 nights lagged, 18.37) and
 * helped a little in every other scenario. Most of the fix is direction: debt and naps no longer move it the wrong way.
 */
export const sleepRecentNights = 3;
export const minSleepNights = 3;
/**
 * Version 38: the level is the mean of the last `levelWindow` scores, held toward `populationMean` (58) as if it were
 * `levelPriorNights` more days at 58 (*tunable*). Recovery is scored against your own normal, so everyone's long-run
 * mean sits near 58, and a short personal mean is mostly noise: a 28-day mean lost to a constant 58 by 0.4 points.
 */
export const levelWindow = 60;
export const levelPriorNights = 60;
/**
 * Persistence: tomorrow leans toward today by φ̂, the lag-1 autocorrelation of the last `phiWindow` scores, held toward
 * `phiPrior` with the weight of `phiPriorNights` days and kept within [0, `phiMax`] (*tunable*).
 */
export const phiWindow = 60;
export const phiPrior = 0.3;
export const phiPriorNights = 10;
export const phiMax = 0.6;
/** While the illness hold runs (an illness-ward run), φ̂ is at least this: tomorrow likely stays as unwell as today. */
export const phiIllness = 0.6;
export const minBandPoints = 8.0;
export const thinBandPoints = 6.0;
export const trustedNights = 10;
/** Nights of Sleep Performance before the forecast is "solid" (with `trustedNights` of Recovery). */
export const solidSleepNights = 7;

export interface RecoveryForecast {
  /** Tomorrow-morning Recovery, 0–100, whole number. */
  charge: number;
  /** Symmetric ± band, whole points. */
  band: number;
  /** max(0, charge − band) */
  low: number;
  /** min(100, charge + band) */
  high: number;
  /** Your long-run level the projection leans away from (version 38; was the 14-day mean). */
  baseline: number;
  /** How much of today's distance from the level carries into tomorrow (version 38). */
  phi: number;
  /** Tonight's expected Sleep Performance (0–1): the mean of your last 3 nights; null with too few (version 38). */
  expectedSleepPerf: number | null;
  /** Recovery points the sleep nudge adds: what Recovery's sleep term would add at that night, ≤ 0 below your usual. */
  sleepAdj: number;
  nights: number;
  confidence: ScoreConfidence;
}

export interface ForecastArgs {
  /** Daily Recovery 0–100, oldest first; the last is today's. */
  recentCharge: number[];
  /** Whether tonight's illness hold is running (RecoveryRow.heldBaseline); raises φ̂ to `phiIllness`. */
  illnessHeld?: boolean;
  /** Today's load so far (TRIMP); null drops the strain term. */
  todayLoad: number | null;
  /** Your typical training session (TRIMP); null drops the strain term. */
  typicalSession?: number | null;
  /** Sleep Performance (0–1) of every earlier night, oldest first, as Recovery's sleep term sees it (version 38). */
  sleepPerfs?: number[];
}

/** null until there are minBaselineNights of recent Recovery. */
export function forecast(a: ForecastArgs): RecoveryForecast | null {
  const chargeWindow = a.recentCharge.slice(-baselineWindow);
  const nights = chargeWindow.length;
  if (nights < minBaselineNights) return null;

  const sd = sampleSD(chargeWindow);
  const levelDays = a.recentCharge.slice(-levelWindow);
  const level = (levelDays.length * mean(levelDays) + levelPriorNights * populationMean) / (levelDays.length + levelPriorNights);
  const phiDays = a.recentCharge.slice(-phiWindow);
  let phi = clamp((phiDays.length * lag1Autocorrelation(phiDays) + phiPriorNights * phiPrior) / (phiDays.length + phiPriorNights), 0.0, phiMax);
  if (a.illnessHeld) phi = Math.max(phi, phiIllness);
  const center = level + phi * (a.recentCharge.at(-1)! - level);

  // Never positive: a light day, or a day not yet past your usual session, leaves tomorrow alone.
  const strainAdj = -Math.min(strainAdjCap, strainPointsPerRecovery * strainPointsAbove(a.todayLoad, a.typicalSession ?? null));

  const { expectedSleepPerf, sleepAdj } = sleepNudge(center, a.sleepPerfs ?? []);

  const charge = Math.round(clamp(center + strainAdj + sleepAdj, 0.0, 100.0));
  let band = Math.max(sd, minBandPoints);
  if (nights < trustedNights) band += thinBandPoints;
  band = Math.round(band);

  return {
    charge,
    band,
    low: Math.max(0.0, charge - band),
    high: Math.min(100.0, charge + band),
    baseline: level,
    phi,
    expectedSleepPerf,
    sleepAdj,
    nights,
    confidence: nights >= trustedNights && (a.sleepPerfs?.length ?? 0) >= solidSleepNights ? "solid" : "building",
  };
}

/**
 * Version 38: the points Recovery's sleep term would move a score of `score` by if tonight's Sleep Performance is the
 * mean of the last `sleepRecentNights`, against your usual night (the same centre and scale Recovery uses). A week of
 * short or broken sleep lowers it; a usual week is 0; sleep debt and naps don't enter at all.
 */
export function sleepNudge(score: number, sleepPerfs: number[]): { expectedSleepPerf: number | null; sleepAdj: number } {
  const recent = sleepPerfs.slice(-sleepRecentNights);
  if (recent.length < minSleepNights) return { expectedSleepPerf: null, sleepAdj: 0 };
  const expectedSleepPerf = mean(recent);
  const zSleep = (expectedSleepPerf - personalSleepCentre(sleepPerfs)) / sleepPerfScale;
  const s = clamp(score, 0.5, 99.5);
  const z = logisticZ0 - Math.log(100 / s - 1) / logisticK;
  return { expectedSleepPerf, sleepAdj: logisticScore(z + wSleep * zSleep) - s };
}

/** 0 for an empty list. */
export const mean = (values: number[]): number => (values.length === 0 ? 0.0 : values.reduce((s, v) => s + v, 0) / values.length);

/** Sample SD (ddof = 1); 0 for fewer than 2 values. */
export function sampleSD(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0.0;
  const m = mean(values);
  let ss = 0.0;
  for (const v of values) ss += (v - m) * (v - m);
  return Math.sqrt(ss / (n - 1));
}

/** Lag-1 autocorrelation (the standard estimator, around the sample mean); 0 for fewer than 3 points or no spread. */
export function lag1Autocorrelation(values: number[]): number {
  if (values.length < 3) return 0.0;
  const m = mean(values);
  let num = 0.0;
  let den = 0.0;
  values.forEach((v, i) => {
    den += (v - m) * (v - m);
    if (i > 0) num += (v - m) * (values[i - 1] - m);
  });
  return den === 0.0 ? 0.0 : num / den;
}


/** Returns x itself at an inclusive bound, preserving its signed zero. */
export function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
