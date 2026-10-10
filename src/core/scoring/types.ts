// Ports the AnalyticsModels.kt subset (MetricCfg, BaselineState, Deviation, UserProfile, HypnogramMetrics)
// plus the HR and sleep-stage shapes the scorers read. All times are unix seconds.

export interface HrSample {
  ts: number;
  bpm: number;
}

/** noop's lowercase stage vocabulary; "awake" is the alternate wake spelling it also accepts. */
export type Stage = "wake" | "awake" | "light" | "deep" | "rem";

export interface StageSegment {
  start: number;
  end: number;
  stage: Stage;
}

/** The DetectedSleep subset hypnogramMetrics reads: the in-bed span and its stage segments. */
export interface SleepSession {
  start: number;
  end: number;
  stages: StageSegment[];
}

export interface HypnogramMetrics {
  tibS: number;
  tstS: number;
  sptS: number;
  solS: number;
  /** null when the night has no REM (noop uses NaN). */
  remLatencyS: number | null;
  wasoS: number;
  efficiency: number;
  disturbances: number;
  deepMin: number;
  remMin: number;
  lightMin: number;
  deepPct: number;
  remPct: number;
  lightPct: number;
}

export interface UserProfile {
  weightKg: number;
  heightCm: number;
  age: number;
  sex: "male" | "female" | "nonbinary";
}

export interface MetricCfg {
  /** Hard reject below. */
  minVal: number;
  /** Hard reject above. */
  maxVal: number;
  floorSpread: number;
  /**
   * The spread floor as a share of the centre (SCORING_VERSION 36): the floor is max(floorSpread, floorRel × |centre|).
   * HRV's night-to-night wobble scales with its level, so a fixed floor muted low-HRV people.
   */
  floorRel?: number;
  /**
   * The floor is this many times larger while the baseline is young (nValid < minNightsTrust; version 36). A week of
   * nights sometimes looks far steadier than the person is (9 % of 7-night samples at HRV 70 ± 15 had a spread under
   * 5 ms); without the larger floor the first fortnight's z ran wide (sd up to 1.3 against about 1).
   */
  youngFloorScale?: number;
  /** Centre half-life, nights. */
  halfLifeB: number;
  /** Spread half-life, nights. */
  halfLifeS: number;
}

export type BaselineStatus = "calibrating" | "provisional" | "trusted" | "stale";

export interface BaselineState {
  /** Robust EWMA centre. */
  baseline: number;
  /** EWMA of absolute deviations, floored at floorOf(cfg, baseline). σ ≈ 1.253 × spread. */
  spread: number;
  nValid: number;
  nightsSinceUpdate: number;
  status: BaselineStatus;
  /** The accepted values while young (≤ earlyAdaptNights), for the robust first week (SCORING_VERSION 32). */
  early?: number[];
  /** The current run of hard-rejected values on one side of the centre; 7 in a row restart the baseline (version 33). */
  rejected?: { side: 1 | -1; values: number[] };
}

export interface Deviation {
  z: number;
  delta: number;
  ratio: number;
  inNormalRange: boolean;
}

export type ScoreConfidence = "calibrating" | "building" | "solid";
