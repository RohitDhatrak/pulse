// Daily load (linear TRIMP) helpers shared by Strain Target, the Sleep Planner and the Recovery forecast
// (SCORING_VERSION 11–12; docs/algorithms/strain-target.md).
import { percentile, toStrainScale, trimpToStrain } from "./strain";

/** A training day is a load of at least this share of the window's 90th percentile (rest days: 4–9 TRIMP on the seed). */
export const trainingDayShare = 0.3;

/** TRIMP → Day Strain, 0–21, as the app displays it. */
export const loadToStrain = (trimp: number): number => toStrainScale(trimpToStrain(trimp));

/** The median of the training days (loads ≥ 30 % of the 90th percentile) in a window, or null with none. */
export function typicalSession(loads: number[]): number | null {
  if (loads.length === 0) return null;
  const sorted = [...loads].sort((a, b) => a - b);
  const threshold = trainingDayShare * percentile(sorted, 90);
  const training = sorted.filter((v) => v >= threshold);
  return training.length ? percentile(training, 50) : null;
}

/**
 * How far today's load (TRIMP so far) is above your typical session, in Day Strain points (0–21 scale), or 0.
 * Strain-point differences are load ratios, so this means the same for light and heavy trainers. One-sided: a rest
 * day, or a day not yet past your usual session, is 0. Used by the Sleep Planner and the Recovery forecast.
 */
export function strainPointsAbove(todayLoad: number | null, session: number | null): number {
  if (todayLoad == null || session == null || !(session > 0)) return 0;
  return Math.max(0, loadToStrain(todayLoad) - loadToStrain(session));
}
