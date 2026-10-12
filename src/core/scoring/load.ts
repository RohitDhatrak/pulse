// Daily load (linear TRIMP) helpers shared by Strain Target, the Sleep Planner and the Recovery forecast
// (SCORING_VERSION 11–12; docs/algorithms/strain-target.md).
import { percentile, toStrainScale, trimpToStrain } from "./strain";

/** A training day is a load of at least this share of the window's 90th percentile (rest days: 4–9 TRIMP on the seed). */
export const trainingDayShare = 0.3;

/**
 * When a day's load counts for training load (version 46): a day with a workout's worth of load counts whatever the
 * wear (a lower bound), and a lighter day only when the band was on long enough while awake to have seen it. A day
 * worn only in bed was a measured rest day (0) although its activity was never seen. Swept in
 * docs/algorithms/training-load.md § Why version 46.
 */
export const seenLoadConfig = {
  /** TRIMP that counts on any wear: well over a rest day (4–9 on the seed), under an easy session. */
  minSeenLoad: 20,
  /** Heart-rate minutes outside sleep that make a lighter day a seen one. 240+ blanked people who wear it 2–6 h. */
  minAwakeWornMin: 120,
};

/**
 * The day's load for training load: `trimp` (0 when worn with too little heart rate), or null when the band was off
 * or the day wasn't seen (`awakeWornMin` under the threshold and too little load to be a workout).
 */
export function seenLoad(trimp: number | null, worn: boolean, awakeWornMin: number): number | null {
  if (!worn) return null;
  const load = trimp ?? 0;
  return load >= seenLoadConfig.minSeenLoad || awakeWornMin >= seenLoadConfig.minAwakeWornMin ? load : null;
}

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

export const hardOrLateConfig = {
  /** Day Strain points beyond your typical session that make a day hard (version 23; *tunable*). */
  hardWorkoutStrainPoints: 2,
  /** A workout ending this close to bedtime is late. */
  lateWorkoutHours: 2,
  /** …if it lasted at least this many minutes. */
  lateWorkoutMinMin: 30,
};

/**
 * Whether yesterday's training explains a strained night (the illness signal's `hardOrLateWorkout`, version 23).
 * Hard: at least `hardWorkoutStrainPoints` Day Strain points above your typical session (`priorLoads`: the days
 * before). Late: a logged workout of `lateWorkoutMinMin`+ minutes ending within `lateWorkoutHours` of `bedtime`.
 * Meant to be narrow, since it dampens the illness signal: an ordinary training day should not count. The late rule
 * has no intensity condition, so it fires after every evening session of 30+ minutes (docs/algorithms/health-monitor.md).
 */
export function hardOrLateWorkout(a: {
  load: number | null;
  priorLoads: number[];
  workouts: { start: number; end: number }[];
  /** That night's main-sleep start, unix seconds, or null. */
  bedtime: number | null;
}): boolean {
  const c = hardOrLateConfig;
  if (strainPointsAbove(a.load, typicalSession(a.priorLoads)) >= c.hardWorkoutStrainPoints) return true;
  if (a.bedtime == null) return false;
  return a.workouts.some(
    (w) => w.end - w.start >= c.lateWorkoutMinMin * 60 && w.end <= a.bedtime! && a.bedtime! - w.end <= c.lateWorkoutHours * 3600,
  );
}
