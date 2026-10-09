// Ports ReadinessEngine.kt (HRV / RHR / resp z-signals, ACWR, Foster monotony → a level) and the
// evaluateWithTrainingLoad wrapper from ReadinessTrainingLoad.kt. Not ported: the memo cache and copy ids.
// Pulse's own (SCORING_VERSION 10): ACWR, monotony and CTL/ATL run on linear TRIMP (`load`), not on the log-mapped
// Effort; the ACWR windows are calendar days ending today; "ramping down" is informational. Why:
// docs/algorithms/training-load.md. Since SCORING_VERSION 27, a chronic load under `acwrChronicFloor` gives no ratio
// ("light load") unless acute ÷ the floor still shows a jump: the ratio of two near-zero means is noise, and one walk
// read "spiking".
import { foldHistory, isoEpochDay, isUsable, readinessHRVLnCfg, restingHRCfg } from "./baselines";
import { readiness as readinessConfidence } from "./confidence";
import { evaluate as evaluateTrainingLoad, standardConfig, type TrainingLoadConfig, type TrainingLoadResult } from "./trainingLoad";
import type { MetricCfg, ScoreConfidence } from "./types";

/**
 * One day's readiness fields. `load` is the day's linear TRIMP (`Stage1Day.trimp`): 0 is a measured rest day,
 * null a day without a usable load (band not worn).
 */
export interface ReadinessDay {
  day: string;
  hrv?: number | null;
  rhr?: number | null;
  resp?: number | null;
  load?: number | null;
}

export type ReadinessLevel = "primed" | "balanced" | "strained" | "rundown" | "insufficient";
export type ReadinessFlag = "good" | "neutral" | "watch" | "bad";
export type ReadinessSignalKey = "hrv" | "rhr" | "respRate" | "acwr" | "monotony";
export type ReadinessDetail =
  | "HRV_GOOD" | "HRV_WATCH" | "HRV_BAD"
  | "RHR_GOOD" | "RHR_WATCH" | "RHR_BAD"
  | "RESP_WATCH" | "RESP_BAD"
  | "NORMAL_RANGE"
  | AcwrBand
  | "MONOTONY_WATCH";

export type ReadinessEvidence =
  | { kind: "metricVsBaseline"; value: number; baseline: number; decimals: number; unit: "ms" | "bpm" | "rpm" }
  | { kind: "monotony"; value: number }
  /** `floor`: set when chronic was under `acwrChronicFloor` and the ratio is acute ÷ floor (version 27). */
  | { kind: "trainingLoad"; acute: number; chronic: number; floor?: number };

export interface ReadinessSignal {
  key: ReadinessSignalKey;
  flag: ReadinessFlag;
  detail: ReadinessDetail;
  evidence: ReadinessEvidence | null;
}

export interface Readiness {
  level: ReadinessLevel;
  signals: ReadinessSignal[];
  /**
   * Acute:chronic workload ratio on TRIMP, or null without enough load history or on a light load. Under the chronic
   * floor it is acute ÷ the floor, kept only when that is a jump (≥ 1.3).
   */
  acwr: number | null;
  /** Chronic load under `acwrChronicFloor` and no jump: too little load to compare weeks (version 27). */
  lightLoad: boolean;
  /** Foster monotony over the last week, or null. */
  monotony: number | null;
  confidence: ScoreConfidence;
}

/**
 * Chronic load (mean TRIMP a day over 28 days) under which the plain ratio isn't used (version 27). About 3.5 h a week
 * of easy walking, under the guideline 150 min of moderate activity. Below it acute ÷ chronic is two near-zero means:
 * one 40-TRIMP walk after weeks of rest read "spiking" for every simulated person. 20 still called a new daily walk
 * "spiking" 67 % of the time; 40 hid a 3×/week 80-TRIMP trainer. docs/algorithms/training-load.md § Why version 27.
 */
export const acwrChronicFloor = 30;
/** Under the floor, acute ÷ floor is kept from here up: "building fast" (1.3) or "spiking" (1.5). */
export const lightLoadJump = 1.3;

export const baselineWindow = 30;
export const minBaseline = 7;
export const acuteWindow = 7;
export const chronicWindow = 28;
/** Days with a load needed in the 28-day chronic window, and in the 7-day acute window. */
export const minChronic = 14;
export const minAcute = 4;
export const respZWatch = 1.5;
export const respZBad = 2.0;
/** SleepStager.respPlausibleRangeBpm, inclusive. */
export const respPlausibleRange = { min: 8.0, max: 25.0 };
export const monotonyWatch = 2.0;
/** An SD at or below this share of the mean (or of 1) is treated as zero: no monotony for identical days. */
export const monotonySdEpsilon = 1e-9;

const inResp = (v: number) => v >= respPlausibleRange.min && v <= respPlausibleRange.max;

export const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Sample SD (n − 1); null for fewer than 2 points. */
export function sampleSD(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs) as number;
  return Math.sqrt(xs.reduce((acc, x) => acc + (x - m) * (x - m), 0) / (xs.length - 1));
}

const pick = (rows: ReadinessDay[], f: (d: ReadinessDay) => number | null | undefined): number[] =>
  rows.map(f).filter((v): v is number => v != null);

function zSignal(
  value: number | null | undefined,
  baseline: number[],
  key: "hrv" | "rhr",
  unit: "ms" | "bpm",
  higherIsBetter: boolean,
  cfg: MetricCfg,
  logDomain: boolean,
): ReadinessSignal | null {
  if (value == null || baseline.length < minBaseline) return null;
  // HRV is z-scored on lnRMSSD; the trailing window re-folds with hard-outlier rejection off.
  const tv = logDomain ? Math.log(Math.max(value, 1.0)) : value;
  const tb = logDomain ? baseline.map((b) => Math.log(Math.max(b, 1.0))) : baseline;
  const state = foldHistory(tb, cfg, false);
  if (!isUsable(state)) return null;
  const sigma = Math.max(1.253 * state.spread, 1e-9);
  if (sigma <= 0) return null;
  const m = state.baseline;
  const z = (higherIsBetter ? tv - m : m - tv) / sigma;
  const prefix = key === "hrv" ? "HRV" : "RHR";
  let flag: ReadinessFlag;
  let detail: ReadinessDetail;
  if (z >= 0.5) [flag, detail] = ["good", `${prefix}_GOOD`];
  else if (z >= -0.5) [flag, detail] = ["neutral", "NORMAL_RANGE"];
  else if (z >= -1.0) [flag, detail] = ["watch", `${prefix}_WATCH`];
  else [flag, detail] = ["bad", `${prefix}_BAD`];
  const evidence: ReadinessEvidence = { kind: "metricVsBaseline", value, baseline: logDomain ? Math.exp(m) : m, decimals: 0, unit };
  return { key, flag, detail, evidence };
}

export type AcwrBand = "LOAD_RAMPING_DOWN" | "LOAD_SWEET_SPOT" | "LOAD_BUILDING_FAST" | "LOAD_SPIKING";

/**
 * The one ACWR banding (noop's): < 0.8 ramping down, [0.8, 1.3) sweet spot, [1.3, 1.5) building fast, ≥ 1.5 spiking.
 * Readiness, Reports and Fitness all band through this, so 1.30 and 1.50 read the same everywhere.
 */
export function acwrBand(ratio: number): AcwrBand {
  if (ratio < 0.8) return "LOAD_RAMPING_DOWN";
  if (ratio < 1.3) return "LOAD_SWEET_SPOT";
  if (ratio < 1.5) return "LOAD_BUILDING_FAST";
  return "LOAD_SPIKING";
}

// Ramping down is informational: on linear load it is every deload, illness or holiday week, not a readiness problem.
const ACWR_FLAG: Record<AcwrBand, ReadinessFlag> = { LOAD_RAMPING_DOWN: "neutral", LOAD_SWEET_SPOT: "good", LOAD_BUILDING_FAST: "watch", LOAD_SPIKING: "bad" };

export function acwrSignal(ratio: number, acute: number, chronic: number): ReadinessSignal {
  const detail = acwrBand(ratio);
  return { key: "acwr", flag: ACWR_FLAG[detail], detail, evidence: { kind: "trainingLoad", acute, chronic } };
}

function synthesize(signals: ReadinessSignal[], hasHistory: boolean): ReadinessLevel {
  if (!hasHistory || signals.length === 0) return "insufficient";
  const bad = signals.filter((s) => s.flag === "bad").length;
  const watch = signals.filter((s) => s.flag === "watch").length;
  const good = signals.filter((s) => s.flag === "good").length;
  const recoveryDown = signals.some((s) => (s.key === "hrv" || s.key === "rhr" || s.key === "respRate") && s.flag === "bad");
  const loadHigh = signals.some((s) => s.key === "acwr" && s.flag === "bad");
  if (bad >= 2 || (recoveryDown && loadHigh)) return "rundown";
  if (recoveryDown || loadHigh || bad >= 1) return "strained";
  if (good >= 2 && watch === 0) return "primed";
  return "balanced";
}

/**
 * Readiness from daily rows in any order. "Today" is the row for `today` when given (none → insufficient),
 * else the newest row. ACWR and monotony use the `load` of the calendar days ending today (rows after it are
 * ignored): acute = the mean over the days with a load among the last 7, chronic = the same over the last 28.
 */
export function evaluate(days: ReadinessDay[], today: string | null = null): Readiness {
  const sorted = [...days].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const latest = today != null ? sorted.find((d) => d.day === today) : sorted.at(-1);
  if (!latest) return { level: "insufficient", signals: [], acwr: null, lightLoad: false, monotony: null, confidence: "calibrating" };
  const history = sorted.filter((d) => d.day < latest.day);
  const recent = history.slice(-baselineWindow);
  const signals: ReadinessSignal[] = [];

  const hrv = zSignal(latest.hrv, pick(recent, (d) => d.hrv), "hrv", "ms", true, readinessHRVLnCfg, true);
  if (hrv) signals.push(hrv);
  const rhr = zSignal(latest.rhr, pick(recent, (d) => d.rhr), "rhr", "bpm", false, restingHRCfg, false);
  if (rhr) signals.push(rhr);

  const rr = latest.resp;
  if (rr != null && inResp(rr)) {
    const base = pick(recent, (d) => d.resp);
    const m = mean(base);
    const sd = sampleSD(base);
    if (base.length >= minBaseline && m != null && inResp(m) && sd != null && sd > 0) {
      const z = (rr - m) / sd;
      const evidence: ReadinessEvidence = { kind: "metricVsBaseline", value: rr, baseline: m, decimals: 1, unit: "rpm" };
      if (z >= respZBad) signals.push({ key: "respRate", flag: "bad", detail: "RESP_BAD", evidence });
      else if (z >= respZWatch) signals.push({ key: "respRate", flag: "watch", detail: "RESP_WATCH", evidence });
    }
  }

  const todayOrdinal = isoEpochDay(latest.day);
  const lastDays = (n: number) =>
    sorted.filter((d) => {
      const o = isoEpochDay(d.day);
      return o != null && todayOrdinal != null && o <= todayOrdinal && o > todayOrdinal - n;
    });
  const acuteLoads = pick(lastDays(acuteWindow), (d) => d.load);
  const chronicLoads = pick(lastDays(chronicWindow), (d) => d.load);
  let acwr: number | null = null;
  let lightLoad = false;
  let monotony: number | null = null;
  if (chronicLoads.length >= minChronic && acuteLoads.length >= minAcute) {
    const acute = mean(acuteLoads) as number;
    const chronic = mean(chronicLoads) as number;
    if (chronic >= acwrChronicFloor) {
      acwr = acute / chronic;
      signals.push(acwrSignal(acwr, acute, chronic));
    } else if (acute / acwrChronicFloor >= lightLoadJump) {
      // A light load that jumped in absolute terms: still building fast or spiking.
      acwr = acute / acwrChronicFloor;
      const signal = acwrSignal(acwr, acute, chronic);
      signals.push({ ...signal, evidence: { kind: "trainingLoad", acute, chronic, floor: acwrChronicFloor } });
    } else {
      lightLoad = true;
    }
    const sd = sampleSD(acuteLoads);
    if (sd != null && sd > monotonySdEpsilon * Math.max(1, Math.abs(acute))) {
      monotony = acute / sd;
      if (monotony >= monotonyWatch) {
        signals.push({ key: "monotony", flag: "watch", detail: "MONOTONY_WATCH", evidence: { kind: "monotony", value: monotony } });
      }
    }
  }

  const level = synthesize(signals, history.length > 0 || acwr != null);
  const confidence = readinessConfidence(level !== "insufficient", pick(recent, (d) => d.hrv).length, baselineWindow);
  return { level, signals, acwr, lightLoad, monotony, confidence };
}

/** Readiness plus CTL/ATL/TSB over the same rows; training load never feeds the readiness level. */
export function evaluateWithTrainingLoad(
  days: ReadinessDay[],
  today: string | null = null,
  config: TrainingLoadConfig = standardConfig,
): { readiness: Readiness; trainingLoad: TrainingLoadResult } {
  return {
    readiness: evaluate(days, today),
    trainingLoad: evaluateTrainingLoad(
      days.map((d) => ({ day: d.day, load: d.load ?? null })),
      today,
      config,
    ),
  };
}
