// Own algorithm (docs/algorithms/energy-bank.md): a 0–100 reserve that starts at wake from Recovery's body signals
// and sleep performance, drains per minute with time awake, Edwards-weighted HR load and high stress, and
// recharges in calm still minutes and naps. Since SCORING_VERSION 20 the start uses Recovery without its own sleep
// term, so last night's sleep counts once (it counted 0.69 per point instead of 0.4).
import { zoneWeight } from "../scoring/strain";
import { stressConfig, type Interval } from "./stress";

export const energyBankConfig = {
  /** Start-of-day weights (spec): Recovery from its body signals only, and sleep performance. */
  wRecovery: 0.6,
  wSleep: 0.4,
  /** Basal drain per awake minute (*tunable*; not in the plan's spec, see the doc). */
  k0: 0.04,
  /** Drain per minute per Edwards zone weight, 1–5 (*tunable*). */
  k1: 0.08,
  /** Drain per minute at stress ≥ stressConfig.highFrom (*tunable*). */
  k2: 0.08,
  /** Recharge per calm still minute, stress < stressConfig.mediumFrom (*tunable*). */
  k3: 0.01,
  /** Recharge per minute asleep in a nap (*tunable*). */
  k4: 0.25,
  /** Drain minutes this close together join one episode (*tunable*). */
  episodeGapMin: 5,
};

/** Edwards zone weight (0–5) of each minute's mean HR, or null without HR. */
export const minuteLoad = (meanHr: (number | null)[], restingHR: number, maxHR: number): (number | null)[] =>
  meanHr.map((bpm) => (bpm == null ? null : zoneWeight(bpm, restingHR, maxHR - restingHR)));

export interface EnergyBankInput {
  /** Local midnight that starts the minute grid, unix seconds (the same grid as stress()). */
  start: number;
  /** The main sleep's end, unix seconds. The curve starts here. */
  wake: number;
  /** Last moment to compute, unix seconds: tonight's bedtime once known, else now, else the day's end. */
  until: number;
  /**
   * 0–100: Recovery from its body signals only (HRV, resting HR, breathing, skin temperature), its own sleep term
   * left out (`recovery()` with no `sleepPerf`), so last night's sleep counts once, through `sleepPerformance`.
   */
  recoveryWithoutSleep: number;
  /** 0–100. */
  sleepPerformance: number;
  /** Edwards zone weight per minute (minuteLoad). */
  load: (number | null)[];
  /** stress().minutes. */
  stress: (number | null)[];
  /** Naps after wake. Their minutes recharge at k4 and nothing else applies. */
  naps: Interval[];
  /** Workouts, so HR load inside one is labelled with its name. */
  workouts?: (Interval & { label: string })[];
}

export interface Drain {
  /** The workout's label, "Activity" for HR load outside workouts, or "Stress". */
  label: string;
  kind: "workout" | "activity" | "stress";
  /** Unix seconds, [start, end). */
  start: number;
  end: number;
  /** Energy points drained. */
  amount: number;
}

export interface EnergyBankResult {
  startLevel: number;
  /** Level at the end of each grid minute from wake to `until`; null outside that span. */
  curve: (number | null)[];
  /** The last computed level. */
  current: number;
  /** The three biggest drain episodes, largest first. The basal drain is not listed. */
  topDrains: Drain[];
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** The level at wake: 0.6 × Recovery's body signals + 0.4 × sleep performance, within 0–100. */
export function energyStart(recoveryWithoutSleep: number, sleepPerformance: number): number {
  const c = energyBankConfig;
  return clamp(c.wRecovery * recoveryWithoutSleep + c.wSleep * sleepPerformance, 0, 100);
}

export function energyBank(input: EnergyBankInput): EnergyBankResult {
  const c = energyBankConfig;
  const { start, load, stress } = input;
  const n = Math.max(load.length, stress.length);
  const minuteOf = (ts: number) => clamp(Math.floor((ts - start) / 60), 0, n);
  const inAny = <T extends Interval>(ts: number, xs: T[] = []) => xs.find((x) => ts < x.end && ts + 60 > x.start);
  const startLevel = energyStart(input.recoveryWithoutSleep, input.sleepPerformance);

  const curve: (number | null)[] = new Array(n).fill(null);
  const open = new Map<string, Drain>();
  const episodes: Drain[] = [];
  const drain = (label: string, kind: Drain["kind"], ts: number, amount: number) => {
    const ep = open.get(label);
    if (ep && ts - ep.end <= c.episodeGapMin * 60) {
      ep.end = ts + 60;
      ep.amount += amount;
      return;
    }
    const next = { label, kind, start: ts, end: ts + 60, amount };
    open.set(label, next);
    episodes.push(next);
  };

  let level = startLevel;
  const until = Math.min(n, Math.ceil((input.until - start) / 60));
  for (let m = minuteOf(input.wake); m < until; m++) {
    const ts = start + m * 60;
    if (inAny(ts, input.naps)) {
      level += c.k4;
    } else {
      level -= c.k0;
      const w = load[m] ?? 0;
      if (w > 0) {
        const workout = inAny(ts, input.workouts);
        drain(workout ? workout.label : "Activity", workout ? "workout" : "activity", ts, c.k1 * w);
        level -= c.k1 * w;
      }
      const s = stress[m];
      if (s != null && s >= stressConfig.highFrom) {
        drain("Stress", "stress", ts, c.k2);
        level -= c.k2;
      } else if (s != null && s < stressConfig.mediumFrom) {
        level += c.k3;
      }
    }
    level = clamp(level, 0, 100);
    curve[m] = level;
  }

  const topDrains = episodes.sort((a, b) => b.amount - a.amount).slice(0, 3);
  return { startLevel, curve, current: level, topDrains };
}
