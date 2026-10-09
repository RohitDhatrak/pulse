// Own algorithm (docs/algorithms/strain-target.md): today's Day Strain range on the reference app's 0–21 scale.
// Since SCORING_VERSION 11 it is worked out in linear load (TRIMP) and converted to 0–21 only for display:
// your typical training session × a Recovery multiplier centred on your own last 28 days, about one Strain point
// wide, capped while load climbs fast or while you come back from a break (5 days without a session). Every
// constant below was checked by simulating light, heavy, daily and sedentary users and 26 weeks of following the
// target (see the doc). Since SCORING_VERSION 26 the progression limit compares sessions with sessions: it used the
// earlier window's "typical session", which after a low month (a beginner, a break with the band on) was a rest day,
// and pinned the target near rest level for up to 5 weeks.
import { loadToStrain, trainingDayShare, typicalSession } from "../scoring/load";
import { percentile } from "../scoring/strain";
import { band, type RecoveryBand } from "../scoring/recovery";

export { strainPointsAbove, typicalSession } from "../scoring/load";

export const strainTargetConfig = {
  /** Days behind the typical session, and the earlier window the progression limit compares with. */
  windowDays: 28,
  /** Fewer days with a load than this → no target (calibrating); in practice the target starts on day 8. */
  minDays: 7,
  /** Fewer days with a load than this → still shown, tagged as an estimate. */
  estimateBelowDays: 14,
  /** A training day is a load of at least this share of the window's 90th percentile. */
  trainingDayShare,
  /**
   * The typical session may grow at most this much over the previous 28 days' sessions (needs `estimateBelowDays`
   * loads there, and `minEarlierSessions` of them sessions at today's level).
   */
  maxGrowth: 0.1,
  /**
   * Sessions at today's level (≥ `trainingDayShare` × today's typical session) the previous 28 days need before the
   * limit applies, about one a week (version 26). With fewer, those weeks were a low period, not a smaller habit to
   * grow from; 3 still let a mostly-rest window hold a beginner down (docs/algorithms/strain-target.md).
   */
  minEarlierSessions: 4,
  /** ln(multiplier) anchors on Recovery, linear in between and flat outside: a normal night (58) is 1×. */
  anchors: [
    [10, Math.log(0.35)],
    [58, 0],
    [90, Math.log(1.4)],
  ] as readonly (readonly [number, number])[],
  /** Recoveries needed before the multiplier is centred on your own last 28 days. */
  minRecoveriesToCentre: 14,
  /** The range is mid ÷ width … mid × width (symmetric in load; about one Strain point). */
  width: 1.25,
  /** ACWR above this caps the upper bound at the typical session (readiness' "building fast" edge). */
  acwrCapAbove: 1.3,
  /**
   * A break: none of the last this-many days was a training day (≥ `trainingDayShare` × the typical session), worn
   * or not. "5 of the last 7" fired on ordinary 2–3-session weeks, whose gaps are at most 3 days.
   */
  breakDays: 5,
  /** Display bounds, 0–21. */
  min: 4,
  max: 19,
};

export interface StrainTarget {
  /** 0–21. */
  low: number;
  high: number;
  /** Your typical training session on the 0–21 scale. */
  base: number;
  band: RecoveryBand;
  /** Fewer than `estimateBelowDays` days with a load: the range is your own, but an estimate. */
  coldStart: boolean;
  /** "capped": load climbing fast (ACWR > 1.3); "returning": coming back from a break. */
  acwrRule: "capped" | "returning" | null;
}

export interface StrainTargetInput {
  /** Daily TRIMP for the days before today, oldest first; null is a day without a load (band off). */
  priorLoad: (number | null)[];
  /** Recovery scores of the days before today, oldest first. */
  priorRecovery: number[];
  /** Today's Recovery, 0–100. */
  recovery: number;
  /** Readiness' ACWR (linear TRIMP) for yesterday, or null. */
  acwr: number | null;
}

const observed = (xs: (number | null)[]) => xs.filter((v): v is number => v != null);

/** ln of the Recovery multiplier before centring: piecewise linear between the anchors, flat outside. */
export function recoveryLogMultiplier(recovery: number): number {
  const a = strainTargetConfig.anchors;
  if (recovery <= a[0][0]) return a[0][1];
  for (let i = 1; i < a.length; i++) {
    if (recovery <= a[i][0]) {
      const t = (recovery - a[i - 1][0]) / (a[i][0] - a[i - 1][0]);
      return a[i - 1][1] + t * (a[i][1] - a[i - 1][1]);
    }
  }
  return a[a.length - 1][1];
}

const toStrain = loadToStrain;

/** Today's Strain range, or null while there are fewer than `minDays` days with a load. */
export function strainTarget({ priorLoad, priorRecovery, recovery, acwr }: StrainTargetInput): StrainTarget | null {
  const c = strainTargetConfig;
  const window = observed(priorLoad.slice(-c.windowDays));
  if (window.length < c.minDays) return null;
  let ref = typicalSession(window);
  if (ref == null || !(ref > 0)) return null;

  // Progression limit: a target built on what you followed would otherwise ratchet up month after month. Like with
  // like: the earlier month's sessions at today's level, not its typical day, which after a low month is a rest day.
  const earlier = observed(priorLoad.slice(-2 * c.windowDays, -c.windowDays));
  const earlierSessions = earlier.filter((v) => v >= c.trainingDayShare * ref!).sort((a, b) => a - b);
  if (earlier.length >= c.estimateBelowDays && earlierSessions.length >= c.minEarlierSessions) {
    ref = Math.min(ref, (1 + c.maxGrowth) * percentile(earlierSessions, 50));
  }

  // Centred on your own recent Recoveries, so your usual day asks for your usual session.
  const recent = priorRecovery.slice(-c.windowDays);
  const centre =
    recent.length >= c.minRecoveriesToCentre ? recent.reduce((a, r) => a + recoveryLogMultiplier(r), 0) / recent.length : 0;
  const mid = ref * Math.exp(recoveryLogMultiplier(recovery) - centre);
  let lo = mid / c.width;
  let hi = mid * c.width;

  const restBelow = c.trainingDayShare * ref;
  const lastDays = priorLoad.slice(-c.breakDays);
  const onBreak = lastDays.length === c.breakDays && lastDays.every((v) => v == null || v < restBelow);
  let acwrRule: StrainTarget["acwrRule"] = null;
  if (acwr != null && acwr > c.acwrCapAbove) acwrRule = "capped";
  else if (onBreak) acwrRule = "returning";
  if (acwrRule) {
    // No more than your typical session; the width is kept.
    hi = Math.min(hi, ref);
    lo = Math.min(lo, hi / (c.width * c.width));
  }

  // To 0–21, then shift (never squeeze) the range into the display bounds.
  let low = toStrain(lo);
  let high = toStrain(hi);
  if (low < c.min) [low, high] = [c.min, Math.min(c.max, high + (c.min - low))];
  if (high > c.max) [low, high] = [Math.max(c.min, low - (high - c.max)), c.max];

  return {
    low,
    high,
    base: toStrain(ref),
    band: band(recovery),
    coldStart: window.length < c.estimateBelowDays,
    acwrRule,
  };
}
