// Stored shapes: the daily_scores JSON columns the queries read, and the options both stages take.
import type { ReasonCode } from "@/lib/reasons";
import type { ChargeDriver } from "@/core/scoring/drivers";
import type { RecoveryForecast } from "@/core/scoring/forecast";
import type { HrRecoveryResult } from "@/core/scoring/hrRecovery";
import type { NightSummary } from "@/core/scoring/sleep";
import type { BaselineState } from "@/core/scoring/types";
import type { Drain } from "@/core/algorithms/energyBank";
import type { FitnessCategory } from "@/core/algorithms/fitnessLevel";
import type { HealthMonitorResult } from "@/core/algorithms/healthMonitor";
import type { HealthspanResult } from "@/core/algorithms/healthspan";
import type { TagImpact } from "@/core/algorithms/journalImpact";
import type { SleepPlan } from "@/core/algorithms/sleepPlanner";
import type { Interval } from "@/core/algorithms/stress";
import type { StrainTarget } from "@/core/algorithms/strainTarget";

/**
 * Bump on any scoring change; a mismatch at startup reruns both stages for every day.
 * 1: U5 scorers. 2: SRI consistency in sleep performance (U7), U10 pipeline. 3: one age helper
 * (healthspan and fitness age agree with whole years on birthdays). 4: local days open at the right instant
 * where DST starts at midnight (Santiago, Havana, Azores...), so the 23-hour day is the right one. 5: Pulse Age's
 * stored key is `pulseAge` (was a brand name), so stored healthspan rows rescore. 6: Google's inputs first (its daily
 * zones, resting HR, time in zones, skin-temperature baseline and personal ranges), four named zones. 7: five
 * display zones on heart-rate reserve (Strain's and WHOOP's 50/60/70/80/90%) in place of Google's four. 8: max HR
 * no longer from Google's PEAK zone (a flat 220), so zones and Strain use the person's own or Tanaka's. 9: a
 * baseline's spread is learned as a running mean over its first nights (it used to start at the floor and climb
 * for weeks), and z-scores shrink by n / (n + 2), so early Recovery, drivers, Health Monitor ranges, Readiness and
 * Journal impact all move. 10: training load (ACWR, monotony, CTL/ATL/TSB) on each day's linear TRIMP (now stored
 * as `strain.trimp`) instead of the log-mapped Effort; ACWR windows in calendar days ending today; "ramping down"
 * informational (no watch signal, no Strain Target lift); CTL/ATL carried across gaps of up to 3 days. 11: Strain
 * Target in linear load: your typical session × a Recovery multiplier centred on your own last 28 days, about one
 * Strain point wide, +10 % growth per 4 weeks at most, capped at your usual session when ramping or back from a break.
 * 12: the Sleep Planner's extra sleep and the Recovery forecast's strain nudge count only the Strain points today goes
 * above your typical session (one-sided; they compared with your average day, so every rest day and every
 * not-yet-trained morning nudged the forecast +12). 13: Stress against your usual still level (the folded median
 * still-minute HR, not the calmest hour), a minute at it reads 0.4, and high needs 2 minutes in a row; the Energy
 * Bank drains less on calm days as a result. 14: Pulse Age scores a missing input as a typical person of your age and
 * sex (it scaled the others up by 9 / n), and counts steps and zones 1–3 once, the larger penalty. 15: sleep need is
 * the median of the last 28 nights (was the upper quartile), floored at 7 h asleep for adults (was 8), 7.5 h before
 * 7 nights (was 8): a healthy 7 h sleeper no longer carries 73 min of permanent debt. 16: the Health Monitor's own
 * ranges are ± 2.5σ (was 2); Google's ranges and the SpO2 95 % floor are unchanged. 17: Recovery's sleep term is
 * centred on your own average sleep performance over the prior 28 nights (0.85 until 7 exist), not a fixed 0.85.
 * 18: journal impact uses a Welch t interval (was a percentile bootstrap, which flagged 12.5 % of null effects at
 * 90 %), labels an effect clear only when it survives Benjamini–Hochberg (q 0.1) across that metric's behaviours and
 * "possible" otherwise, and leaves days next to an illness out of the other behaviours' comparisons.
 * 19: Pulse Age against a person who meets health guidelines (VO2max median, 8,000 steps, 100 + 15 zone minutes,
 * SRI 81, resting HR 60 / 64) instead of a fit one; run and daily VO2max blended by count (one run reading replaced
 * six months of estimates); activity curves on rolling 7-day windows; no result before 14 days of activity data;
 * zone and strength minutes only on days worn ≥ 10 h awake; strength unknown until a workout is logged; no long-sleep
 * or high-strength penalty; per-sex lean mass; SRI below 65 and the VO2max reference past 75 extended; steps ramp
 * between 55 and 65 (see docs/algorithms/healthspan.md § Why version 19).
 * 20: the Energy Bank starts at 0.6 × Recovery without its sleep term + 0.4 × sleep performance, so last night's
 * sleep counts once (it counted 0.69 per point, 42 % of it through Recovery). Recovery itself is unchanged.
 * 21: Stress leaves out exertion (≥ 40 % of heart-rate reserve) and the 30 minutes after it or a logged workout;
 * each minute's reference follows a slow rise over the previous 5 hours (heat, caffeine, illness); and a day more than
 * 2σ above the daytime baseline is not folded into it. The Energy Bank reads the corrected stress.
 * 22: the Health Monitor's SpO2 is low at 2 points below your own normal (or its 2.5σ range, if narrower) or below a 92 %
 * safety floor, not below a fixed 95 % (which flagged most ordinary nights for people whose normal is 94–96 %).
 * 23: the illness signal's 30-night window skips the 3 nights before last night (a running illness entered its own
 * baseline and faded), and yesterday's hard (2+ Day Strain points over your typical session) or late (ending within
 * 2 h of sleep) workout is passed as a confounder.
 * 24: the Sleep Planner's time in bed is bounded: bedtimes assume at least 85 % efficiency (planning at your own low
 * efficiency sent people with insomnia to bed at about 18:30), and time in bed is capped by age at the National Sleep
 * Foundation's "may be appropriate" upper bound (12 h under 14, 11 h to 25, 10 h to 64, 9 h from 65).
 * 25: a night spent awake counts as no sleep in the debt ledger (it was skipped like a night without data, so an
 * all-nighter added no debt while a 1 h night added about 214 min). Only with positive evidence over 00:00–06:00: no
 * sleep session, the band worn, median HR at least 5 above resting and 100+ steps. Stage 1 stores the night's summary.
 * 26: Strain Target's progression limit compares sessions with sessions: 1.1 × the median of the previous 28 days'
 * sessions at today's level, only when there are 4+. It used that month's typical day, which after a low month (a
 * beginner, a break with the band on) was a rest day, pinning the target near rest for up to 5 weeks.
 * 27: ACWR under a chronic load of 30 TRIMP a day is a light load with no ratio (one walk after weeks of rest read
 * "spiking" and made readiness "strained"), unless acute ÷ 30 still shows a jump (≥ 1.3), which bands as usual.
 * 28: Pace of Aging's 30-day activity terms need 14 days worn ≥ 10 h awake (else the 6-month term stays), and are
 * shrunk toward the 6-month term by 3n / (n + 60), full at 30 days: one worn day used to swing Pace from 0.7 to 2.7.
 * 29: Pulse Age's strength term is weighted n / (n + 8) for n strength workouts logged in 6 months: one logged session
 * added about 1.5 years (every later worn day counted as 0), then fell away overnight 180 days later.
 * 30: Recovery's baselines and sleep centre hold (don't fold) the second and later nights of a run of illness-ward
 * nights (HRV down and resting HR up, (−z_HRV + z_RHR) / 2 ≥ 1), up to 21 in a row: folding every night absorbed an
 * illness, so the week after read 82 % green after a 21-night one (32 % before).
 * 31: a main sleep without stages scores its restorative part at your usual (the median of the last 28 staged nights,
 * from 5), or leaves it out and renormalises with fewer: deep and REM counted as 0 cost 9–16 points.
 * 32: baselines (with hard-outlier rejection) take a robust first week: the centre and spread are a trimmed estimate
 * over the first 8 accepted values, so one early glitch can't inflate the spread for weeks (sd(z) 0.28 → 0.91 in week 2
 * after a 180 ms night 3). The illness hold acts only once a baseline is past its first week.
 * 33: 7 hard-rejected values in a row on one side restart a baseline from them: after a real step bigger than the gate
 * (a new device, a beta-blocker) every night was rejected and the baseline stayed at the old normal for good.
 * 34: "count my data from" (Settings): days before a person's chosen date are left out of scoring entirely, so a device
 * switch (offered from the main sleeps' source) can start every baseline fresh. Earlier data stays stored.
 * 35: Recovery, readiness, the Health Monitor and the illness signal score Fitbit's non-REM heart rate (the sleeping
 * resting HR) against its own baseline once that baseline is trusted, else Google's daily resting HR against its own;
 * the two never share a baseline (about 6 bpm apart). Strain's zones and Pulse Age keep Google's. Sleep rows carry the
 * night's brief awakenings (Disturbances, shown only).
 * 36: HRV's baseline spread floor is 5 % of your HRV, at least 1 ms (was 5 ms), and resting HR's 1 bpm (was 2), each
 * larger until 14 nights: low-HRV and steady people's Recovery, illness signal and Health Monitor ranges were muted.
 * Stress also skips sustained light movement below the exertion line and the heart rate easing off after it.
 * 37: Recovery on a night with fewer inputs (no breathing, skin temperature, sleep or resting HR, or one not yet usable)
 * is scaled back to the full set's spread, so it is as calm as a full night: HRV alone read 30 % red days against 20 %.
 * 38: Tomorrow's Recovery forecast leans from your 60-day level (held toward 58) toward today by your own persistence,
 * more while the illness hold runs, instead of the 14-day mean minus its slope; its sleep nudge is what Recovery's
 * sleep term would add if tonight goes like your last 3 nights, not the Sleep Planner's advice (debt raised it, naps
 * lowered it).
 * 39: Recovery never scores or folds Pulse's session estimate (8.6 bpm under Google's resting HR on the owner's nights):
 * a night without Google's value uses the sleeping HR against its own baseline, else leaves the resting-HR term out.
 * 40: Sleep need rises at once but falls at most half a minute a night, so chronic short sleep isn't absorbed within
 * weeks; the debt ledger adds each night's whole shortfall beyond a 30-minute tolerance and carries 60 % (was 55 % of
 * need + debt − slept, which never showed more than about 1.2 nights' shortfall).
 * 41: The Sleep Planner's typical wake time is a median on the 24 h clock (23:40 and 00:20 gave 12:00), taken from
 * nights like last night (a shift worker's current schedule) within tomorrow's kind of day.
 * 42: A nap covers only tonight's extras (strain and debt repayment), never the baseline need (a 1 h 50 min nap took a
 *     7.5 h need to 5 h 40 min); the sleep need's age floor is each guideline range's lower bound (8 h for 13–17, was 9)
 *     and slides by exact age (8 → 7 across 17–19), so the 18th birthday no longer drops 75 min of debt overnight.
 * 43: The Sleep score's restorative targets ease with age: 13 % deep and 50 % deep + REM to 40, sliding to 9.1 % and 42 %
 *     at 60 (the age-typical decline), so healthy older sleepers aren't marked down about 9 points.
 * 44: A sleep regularity period counts when we know how its night went (a main sleep, or the night spent awake), not
 *     when the band was worn 720+ minutes: night-only wearers get an SRI, and a missed night no longer reads as awake.
 * 45: The training-load ratio is EWMA acute ÷ EWMA chronic (τ 7 and 42, Fitness' ATL and CTL), not a 7-day mean over a
 *     28-day one: a session no longer drops out at once on day 8, so the same weekly load on different days stops
 *     swinging between building fast, spiking and ramping down (and capping the Strain Target).
 * 46: Training load reads complete, seen days: the ratio, monotony and the readiness load signal run through
 *     yesterday (this morning's near-0 load flipped the band after the workout), and a day worn only in bed is unknown
 *     (under 20 TRIMP and 120 minutes of awake wear) instead of a measured rest day. The row stores the day's `load`;
 *     `acwrPrior` is gone (Strain Target reads the row's ratio, the same value).
 * 47: Monotony is information only: it no longer raises a "watch" that kept every regular daily trainer from "primed",
 *     and identical days read the cap (10) instead of no monotony.
 * 48: Strain Target's typical session is at least a starter session (30 TRIMP, Strain 8.1): someone whose heart rate
 *     never reached zone 1 had no target ("calibrating" forever), and someone training every other week was asked
 *     for a rest day. The row gains `starter`.
 * 49: Fitness level's percentile compares with the exact age (FRIEND rows between decade midpoints; past 75 scaled
 *     with Healthspan's reference), not the decade's row: a decade birthday moved it 18–30 points, and someone at
 *     Healthspan's median read the 37th–66th (8th at 95).
 * 50: Stress's baseline accepts a new normal: 7 gated days in a row (not on Recovery's illness hold) fold, so a lasting
 *     rise in daytime HR is taken in within weeks instead of reading as stress for months.
 * 51: One workout per session: the same session from two sources (the band's recording and an app's Health Connect
 *     copy, overlapping by 80 %+) is merged into the band's, so it isn't scored, listed or counted as strength twice.
 * 52: An atypical first week (ill, hungover) no longer becomes the stress reference: the first 28 days' still
 *     medians are judged against their own median, and those beyond 2 robust σ, on either side, are left out.
 * 53: One night from its pieces: sleep sessions chained to the main by awake gaps of up to 2 h are part of the night,
 *     not naps. A broken night had started the Energy Bank at the first piece's end and recharged it through the rest
 *     (+30), and Sleep had scored half the night.
 * 54: The Energy Bank runs from wake to the next main sleep, across midnight (at most 24 h): an after-midnight
 *     bedtime and a night shift were in no bank, and the day's value was taken at midnight.
 */
export const SCORING_VERSION = 54;

export type PipelineOptions = {
  /** Whose data: every read and write is scoped to this user. */
  userId: number;
  timeZone: string;
  profile: { birthDate: string; sex: "male" | "female"; maxHr: number; heightCm?: number | null };
  /**
   * "Count my data from" (Settings, version 34): days before it are left out entirely, so every score, baseline,
   * report and journal-impact result starts there. Stage 2 then deletes the stored rows outside the loaded days.
   */
  dataFrom?: string | null;
};

export type BaselineSummary = { mean: number; sd: number; status: BaselineState["status"]; nValid: number } | null;

/** Stage 1, `daily_scores.strain`. */
export type Stage1Day = {
  /** Hash of the non-sample inputs; a change reruns stage 1 for the day. */
  key: string;
  hrCount: number;
  /** Minutes with HR before and after local noon (SRI coverage). */
  hrMinutesAm: number;
  hrMinutesPm: number;
  lastHrTs: number | null;
  /** The day's last step (version 54): how long a live Energy Bank runs on past midnight before a sleep has synced. */
  lastStepTs?: number | null;
  restingHr: number;
  /** Google's daily resting HR first, then Pulse's sleep-session estimate. */
  restingHrSource: "daily" | "session" | "default";
  maxHr: number;
  /** Effort 0–100, or null with too little HR. */
  effort: number | null;
  /** The linear TRIMP behind `effort` (null with it). Training load (ACWR, monotony, CTL/ATL) runs on this. */
  trimp: number | null;
  /** Zones 1–5 on heart-rate reserve: lower bounds (bpm) and seconds. */
  zoneLower: number[];
  zoneSeconds: number[];
  /** Stress Monitor's resting daytime HR for the day (independent of the baseline). */
  dayAggregate: number | null;
  stillMinutes: number;
  /**
   * The night's core, local 00:00–06:00 (`nightSummary`): minutes with HR, their median minute HR, and steps. Tells a
   * night spent awake from one without data (version 25, `awakeAllNight`).
   */
  night: NightSummary;
};

/** Stage 1, `daily_scores.activities`. */
export type Stage1Activity = {
  id: string;
  effort: number | null;
  hrCount: number;
  avgHr: number | null;
  maxHr: number | null;
  zoneSeconds: number[];
  hrr: HrRecoveryResult | null;
};

export type RecoveryRow = {
  value: number | null;
  /**
   * Tonight's values were not folded into the baselines or the sleep centre: the second or later night of a run of
   * illness-ward nights (SCORING_VERSION 30, `nextHold`), so a sickness isn't absorbed into "normal".
   */
  heldBaseline: boolean;
  /**
   * The same Recovery from its body signals only (its sleep term left out), for the Energy Bank's start, which adds
   * sleep performance itself (SCORING_VERSION 20). Null when `value` is; equal to it on a night without sleep data.
   */
  withoutSleep?: number | null;
  reason: ReasonCode | null;
  nightsLeft?: number;
  provisional: boolean;
  /** Inputs whose baseline is stale today. */
  stale: string[];
  /** Terms the score used. */
  terms: string[];
  /** The score gained a term after it was first shown. */
  updated: boolean;
  /** `sleepCentre`: your usual sleep performance (0–1) the sleep term was scored against (SCORING_VERSION 17). */
  inputs: {
    hrv: number | null;
    /** The resting HR Recovery scored: `sleepHr` once its baseline is established, else `dailyRhr` (version 35). */
    rhr: number | null;
    rhrSource?: RestingSource | null;
    /** Fitbit's non-REM heart rate for the night, folded into its own baseline. */
    sleepHr?: number | null;
    /** Google's daily resting HR, folded into the resting-HR baseline (version 39: never Pulse's session estimate). */
    dailyRhr?: number | null;
    resp: number | null;
    sleepPerf: number | null;
    sleepCentre?: number;
    skinTempDev: number | null;
  };
  baselines: { hrv: BaselineSummary; rhr: BaselineSummary; resp: BaselineSummary; skinTemp: BaselineSummary };
  hrvZ: number | null;
  drivers: ChargeDriver[];
  forecast: RecoveryForecast | null;
  forecastNightsLeft: number;
};

/** Where Recovery's resting HR came from (version 35): Fitbit's non-REM heart rate or Google's daily value (since version 39 never Pulse's session estimate). */
export type RestingSource = "sleep" | "daily";

export type SleepRow = {
  reason: ReasonCode | null;
  main: {
    id: string;
    start: number;
    end: number;
    processed: boolean;
    staged: boolean;
    inBedMin: number;
    asleepMin: number;
    awakeMin: number;
    deepMin: number | null;
    remMin: number | null;
    lightMin: number | null;
    efficiency: number;
    wakeEvents: number | null;
    /** Fitbit's brief awakenings on a staged night (shown, not scored; version 35), else null. */
    disturbances?: number | null;
    /** A night joined from several sessions (version 53): each piece's id and span, in time order. */
    parts?: { id: string; start: number; end: number }[];
  } | null;
  naps: { id: string; start: number; end: number; asleepMin: number }[];
  /** 0–100 */
  performance: number | null;
  needHours: number;
  needNights: number;
  /**
   * No sleep session and the night's core shows you up and about (version 25, `awakeAllNight`): the ledger counts the
   * night as 0 plus naps, and `reason` is "no_sleep".
   */
  awakeAllNight: boolean;
  /**
   * Where the restorative part of `performance` came from (version 31): the night's stages, your usual (the median of
   * recent staged nights, for a night without stages), or left out (too few staged nights to know). Null without one.
   */
  restorative: "measured" | "usual" | "omitted" | null;
  /** Main sleep plus yesterday's naps, the debt ledger's night; 0 + naps after a night spent awake. */
  creditedMin: number | null;
  debtMin: number;
  /** Raw SRI on [−100, 100] over the 7 nights ending on D. */
  sri: number | null;
  /** 0–100 display value. */
  consistency: number | null;
};

export type StressRow = {
  provisional: boolean;
  average: number | null;
  lowMin: number;
  mediumMin: number;
  highMin: number;
  latest: { ts: number; value: number } | null;
  longestHigh: { start: number; minutes: number } | null;
  referenceHr: number | null;
};

export type EnergyBankRow =
  | { value: null; reason: ReasonCode; provisional: boolean }
  | {
      value: number;
      reason: null;
      provisional: boolean;
      startLevel: number;
      wake: number;
      until: number;
      charged: number;
      drained: number;
      topDrains: Drain[];
      naps: Interval[];
    };

export type TrainingLoadRow = {
  /** The day's load as training load counts it (TRIMP), or null when the band was off or the day not seen (version 46). */
  load: number | null;
  /** Through the day before D (version 46; was through D, and Strain Target read the day before's as `acwrPrior`). */
  acwr: number | null;
  /** Too little chronic load to compare weeks: no ratio (version 27, readiness' `acwrChronicFloor`). */
  lightLoad: boolean;
  /** Foster monotony through the day before D, at most 10; information only, never in `level` (version 47). */
  monotony: number | null;
  level: string;
  state: string;
  contiguousDays: number;
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
};

export type StrainTargetRow = ({ reason: null } & StrainTarget) | { reason: ReasonCode; nightsLeft?: number };

export type SleepPlannerRow =
  | ({ reason: null; wakeDay: string; nights: number } & SleepPlan)
  | { reason: ReasonCode; nightsLeft?: number; needMin: number };

export type HealthMonitorRow = (HealthMonitorResult & { reason: null; stale: string[] }) | { reason: ReasonCode };

/** `activityDays`: days with zone data (worn ≥ 10 h awake) in the 6 months; Pulse Age needs 14 (scoring version 19). */
export type HealthspanRow = (HealthspanResult & { reason: null; age: number }) | { reason: ReasonCode; dataDays: number; activityDays?: number };

export type FitnessRow =
  | { reason: null; vo2max: number; source: "run" | "daily"; sourceDay: string; percentile: number; category: FitnessCategory; age: number }
  | { reason: ReasonCode };

export type JournalImpactRow = { key: string; impacts: TagImpact[] };

/** One day's stage-2 columns, keyed by their daily_scores column name. */
export type Stage2Row = {
  recovery: RecoveryRow;
  sleep: SleepRow;
  training_load: TrainingLoadRow;
  strain_target: StrainTargetRow;
  sleep_planner: SleepPlannerRow;
  energy_bank: EnergyBankRow;
  stress: StressRow;
  health_monitor: HealthMonitorRow;
  healthspan: HealthspanRow;
  fitness: FitnessRow;
  journal_impact: JournalImpactRow;
};

/** Every Stage2Row key, once: `satisfies` fails the build when a column is added to one and not the other. */
export const STAGE2_COLUMNS = Object.keys({
  recovery: 1,
  sleep: 1,
  training_load: 1,
  strain_target: 1,
  sleep_planner: 1,
  energy_bank: 1,
  stress: 1,
  health_monitor: 1,
  healthspan: 1,
  fitness: 1,
  journal_impact: 1,
} satisfies Record<keyof Stage2Row, 1>) as (keyof Stage2Row)[];
