// Own algorithm (docs/algorithms/sleep-planner.md): tonight's sleep need (noop's personalised need, plus a
// strain adjustment and part of the debt, minus today's naps) and the bedtimes that reach 100 %, 85 % and
// 70 % of it before the typical wake time. Since SCORING_VERSION 12 the strain adjustment counts only the Strain
// points today goes above your typical training session (it was above your average day, rest days included).
// Since SCORING_VERSION 24 time in bed is bounded: it was need ÷ your median efficiency, so the worst sleepers got
// the earliest bedtimes (12.6 h in bed at 60 % efficiency, an 18:26 bedtime). Efficiency is planned at no less than
// 85 %, the efficiency CBT-I aims for (more time in bed mostly adds time awake), and time in bed is capped by age at
// the National Sleep Foundation's "may be appropriate" upper bound.
import { strainPointsAbove } from "../scoring/load";

export const sleepPlannerConfig = {
  /** Hours of extra need per Day Strain point (0–21) above your typical session (*tunable*; no published source). */
  hoursPerStrainPoint: 0.05,
  /** Most the strain adjustment adds, minutes. */
  maxStrainMin: 30,
  /** Share of the current debt to repay tonight (*tunable*). */
  debtRepayShare: 0.2,
  /** Nights behind the typical wake time and efficiency (spec). */
  windowNights: 14,
  /** Efficiency when no night has one (*tunable*). */
  defaultEfficiency: 0.9,
  /** Shares of need to plan bedtimes for (spec). */
  shares: [1, 0.85, 0.7],
  /**
   * Lowest efficiency bedtimes are planned at (version 24): the ≥ 85 % target of CBT-I sleep restriction (Edinger 2021,
   * AASM guideline). Below it, planning at your own efficiency sends you to bed hours early to lie awake.
   */
  minPlanningEfficiency: 0.85,
  /**
   * Most hours in bed by age (version 24): the upper "may be appropriate" sleep duration of the National Sleep
   * Foundation (Hirshkowitz 2015). `[fromAge, hours]`, ascending; an unknown age uses `unknownAgeCapHours`.
   */
  inBedCapHours: [
    [0, 12],
    [14, 11],
    [26, 10],
    [65, 9],
  ] as readonly (readonly [number, number])[],
  unknownAgeCapHours: 10,
};

/** The most hours in bed planned for this age (version 24). */
export function inBedCapHours(age: number | null): number {
  const c = sleepPlannerConfig;
  if (age == null || !Number.isFinite(age)) return c.unknownAgeCapHours;
  return c.inBedCapHours.findLast(([from]) => age >= from)?.[1] ?? c.inBedCapHours[0][1];
}

export interface WakeNight {
  /** yyyy-MM-dd of the wake day. */
  day: string;
  /** Local wake time, minutes after midnight. */
  wakeMin: number;
  /** Asleep / in bed, 0–1, or null. */
  efficiency: number | null;
}

export interface SleepPlannerInput {
  /** personalizedNeedHours for tonight. */
  baselineNeedHours: number;
  /** Today's load so far (TRIMP), or null. */
  todayLoad: number | null;
  /** Your typical training session (TRIMP, `typicalSession` over the prior 28 days), or null. */
  typicalSession: number | null;
  /** ledger(...).magnitudeMin as of this morning. */
  debtMin: number;
  /** Minutes asleep in today's naps. */
  napMin: number;
  /** Recent main sleeps, oldest first; the last `windowNights` are used. */
  nights: WakeNight[];
  /** yyyy-MM-dd of tomorrow, the wake day being planned for. */
  wakeDay: string;
  /** Whole years, or null when unknown: sets the time-in-bed cap. */
  age: number | null;
}

export interface BedtimePlan {
  /** 1, 0.85 or 0.7. */
  share: number;
  /** Minutes asleep the plan delivers at the planning efficiency: share × need, unless the time in bed is capped. */
  sleepMin: number;
  /** Minutes in bed: share × min(cap, need ÷ planning efficiency). */
  inBedMin: number;
  /** Minutes from the wake day's local midnight; negative is the evening before (−90 is 22:30). */
  bedtimeMin: number;
}

export interface SleepPlan {
  needMin: number;
  parts: { baselineMin: number; strainMin: number; debtMin: number; napMin: number };
  /** Typical wake time for `wakeDay`, minutes after local midnight; null without nights. */
  wakeMin: number | null;
  weekend: boolean;
  /** Median efficiency of the recent nights (or the default). */
  efficiency: number;
  /** max(efficiency, minPlanningEfficiency): what the bedtimes assume. */
  planningEfficiency: number;
  /** The median efficiency was under minPlanningEfficiency, so bedtimes plan on more of the night asleep. */
  efficiencyFloored: boolean;
  /** The most minutes in bed for this age. */
  inBedCapMin: number;
  /** The 100 % plan would have passed the cap: every tier is a share of the cap, and falls short of its need share. */
  capped: boolean;
  /** 100 % first (earliest bedtime). Empty when wakeMin is null. */
  plans: BedtimePlan[];
}

/** Saturday or Sunday. */
export const isWeekendDay = (day: string): boolean => [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function sleepPlan(input: SleepPlannerInput): SleepPlan {
  const c = sleepPlannerConfig;
  // One-sided: a rest day, a routine session or a day not yet past your usual session adds nothing.
  const strainAbove = strainPointsAbove(input.todayLoad, input.typicalSession);
  const parts = {
    baselineMin: input.baselineNeedHours * 60,
    strainMin: Math.min(c.maxStrainMin, strainAbove * c.hoursPerStrainPoint * 60),
    debtMin: Math.max(0, input.debtMin) * c.debtRepayShare,
    napMin: Math.max(0, input.napMin),
  };
  const needMin = Math.max(0, parts.baselineMin + parts.strainMin + parts.debtMin - parts.napMin);

  const recent = input.nights.slice(-c.windowNights);
  const weekend = isWeekendDay(input.wakeDay);
  const sameKind = recent.filter((n) => isWeekendDay(n.day) === weekend);
  // No night of tomorrow's kind yet: fall back to every recent night.
  const wakeMin = median((sameKind.length ? sameKind : recent).map((n) => n.wakeMin));
  const efficiency = median(recent.flatMap((n) => (n.efficiency != null && n.efficiency > 0 ? [n.efficiency] : []))) ?? c.defaultEfficiency;

  const planningEfficiency = Math.max(efficiency, c.minPlanningEfficiency);
  const inBedCapMin = inBedCapHours(input.age) * 60;
  // Tiers are shares of the full plan, so capped tiers stay distinct; uncapped, inBed = share × need ÷ efficiency.
  const fullInBed = needMin / planningEfficiency;
  const capped = fullInBed > inBedCapMin;
  const plans =
    wakeMin == null
      ? []
      : c.shares.map((share) => {
          const inBedMin = share * Math.min(fullInBed, inBedCapMin);
          const sleepMin = capped ? inBedMin * planningEfficiency : share * needMin;
          return { share, sleepMin, inBedMin, bedtimeMin: wakeMin - inBedMin };
        });
  return { needMin, parts, wakeMin, weekend, efficiency, planningEfficiency, efficiencyFloored: efficiency < c.minPlanningEfficiency, inBedCapMin, capped, plans };
}
