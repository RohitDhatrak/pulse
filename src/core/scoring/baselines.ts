// Ports Baselines.kt: Winsorized EWMA personal baselines, plus the BaselineState.usable / trusted getters
// from AnalyticsModels.kt. Not ported: the manual-recalibration epoch fold and the device-era boundary.
// Pulse's own (SCORING_VERSION 9): the spread is a running mean over the first nights, and z-scores carry an
// n / (n + 2) short-history shrink. Why and how they were calibrated: docs/algorithms/baselines.md.
import type { BaselineState, BaselineStatus, Deviation, MetricCfg } from "./types";

export const winsorK = 3.0;
export const hardOutlierK = 5.0;
export const minNightsSeed = 4;
export const minNightsTrust = 14;
export const staleDays = 14;
/** Days a nightly vital may be carried forward and still shown as "latest". */
export const vitalCarryDays = 7;

// Young regime: below earlyAdaptNights valid nights the centre adapts fast and the hard gate is off.
export const earlyAdaptNights = 8;
export const earlyHalfLifeB = 3.0;
export const earlySpreadInflate = 2.5;

const cfg = (minVal: number, maxVal: number, floorSpread: number, young?: { floorRel?: number; youngFloorScale: number }): MetricCfg => ({
  minVal,
  maxVal,
  floorSpread,
  ...young,
  halfLifeB: 14.0,
  halfLifeS: 21.0,
});

export const metricCfg = {
  /**
   * Version 36: the spread floor is 5 % of your HRV, at least 1 ms (was a fixed 5 ms), and resting HR's is 1 bpm (was 2),
   * each larger (HRV 2×, resting HR 1.5×) until the baseline is trusted at 14 nights. The fixed floors muted anyone with low or very steady values: at HRV 22 ms sd(z) was 0.52
   * and Recovery 5 % red (18 % for others); the Health Monitor's HRV range was 25 ± 21 ms.
   * docs/algorithms/baselines.md § Why version 36.
   */
  hrv: cfg(5.0, 250.0, 1.0, { floorRel: 0.05, youngFloorScale: 2 }),
  resting_hr: cfg(30.0, 120.0, 1.0, { youngFloorScale: 1.5 }),
  resp: cfg(4.0, 40.0, 0.5),
  skin_temp: cfg(20.0, 42.0, 0.3),
  /** Daily Effort on its 0–100 axis. */
  strain: cfg(0.0, 100.0, 5.0),
  /** ln(ms), folded with hard-outlier rejection off (Readiness). */
  readiness_hrv_ln: cfg(2.079, 5.521, 0.08),
  daytime_hr: cfg(35.0, 160.0, 3.0),
  daytime_rmssd: cfg(5.0, 250.0, 7.0),
} satisfies Record<string, MetricCfg>;

export const hrvCfg = metricCfg.hrv;
export const restingHRCfg = metricCfg.resting_hr;
export const respCfg = metricCfg.resp;
export const skinTempCfg = metricCfg.skin_temp;
export const strainCfg = metricCfg.strain;
export const readinessHRVLnCfg = metricCfg.readiness_hrv_ln;
export const daytimeHRCfg = metricCfg.daytime_hr;
export const daytimeRMSSDCfg = metricCfg.daytime_rmssd;

export const isTrusted = (s: BaselineState): boolean => s.status === "trusted";
/** At least provisionally usable (nValid ≥ minNightsSeed and not stale). */
export const isUsable = (s: BaselineState): boolean => s.status === "provisional" || s.status === "trusted";

/** Half-life in nights → EWMA smoothing factor. */
export const lambda = (halfLife: number): number => 1.0 - 0.5 ** (1.0 / halfLife);

export function computeStatus(nValid: number, nightsSinceUpdate: number): BaselineStatus {
  if (nightsSinceUpdate > staleDays && nValid >= minNightsSeed) return "stale";
  if (nValid < minNightsSeed) return "calibrating";
  if (nValid < minNightsTrust) return "provisional";
  return "trusted";
}

const state = (baseline: number, spread: number, nValid: number, nightsSinceUpdate: number): BaselineState => ({
  baseline,
  spread,
  nValid,
  nightsSinceUpdate,
  status: computeStatus(nValid, nightsSinceUpdate),
});

/**
 * The spread floor for a baseline at `centre` with `nValid` accepted values (SCORING_VERSION 36): the absolute floor, or
 * floorRel of the centre if larger, times youngFloorScale until the baseline is trusted.
 */
export const floorOf = (cfg: MetricCfg, centre: number, nValid: number): number =>
  Math.max(cfg.floorSpread, (cfg.floorRel ?? 0) * Math.abs(centre)) * (nValid < minNightsTrust ? (cfg.youngFloorScale ?? 1) : 1);

const inRange = (v: number | null, cfg: MetricCfg): v is number => v != null && cfg.minVal <= v && v <= cfg.maxVal;

/**
 * The robust first week (SCORING_VERSION 32): while young, the centre is the mean of the early values within this many
 * σ (1.4826 × MAD) of their median, and the spread their mean absolute deviation. The young regime's running mean of
 * raw deviations, with the hard gate off, let one early glitch inflate the spread for weeks (sd(z) 0.28 in week 2 after
 * a 180 ms night 3; 0.13 after a glitchy first night). 3σ trimmed too much of a high-wobble person's real tail.
 * docs/algorithms/baselines.md § Why version 32.
 */
export const earlyTrimSigma = 4;

/**
 * Hard-rejected values in a row, on the same side of the centre, that restart a baseline (SCORING_VERSION 33). Past the
 * first week a value more than `hardOutlierK` spreads away is rejected, and a rejected night still counts as seen, so
 * after a real step bigger than the gate (a new device, a beta-blocker) every night was rejected and the baseline
 * stayed at the old normal for good. A run of 7 is taken as a real change: the baseline restarts from those values
 * through the robust first week, back within |z| ≤ 1 in about 12–14 nights. Heavy-tailed noise never made such a run;
 * a severe 10-night illness did in 15 % of cases where every night is folded (the Health Monitor; Recovery's illness
 * hold skips those nights). docs/algorithms/baselines.md § Why version 33.
 */
export const restartAfterRejections = 7;

const median = (xs: number[]): number => {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/**
 * Fold one nightly value. null or out-of-range skips and holds; a hard outlier (once settled) is seen but
 * not folded; otherwise a Winsorized EWMA centre and an EWMA-abs-dev spread. While young (the first
 * `earlyAdaptNights` accepted values, when the hard gate is off) the centre and spread are a trimmed estimate over
 * those values instead (version 32).
 * `rejectHardOutliers = false` is the trailing-window re-fold mode (Readiness), which keeps the plain young regime.
 */
export function update(
  prev: BaselineState | null,
  value: number | null,
  cfg: MetricCfg,
  rejectHardOutliers = true,
): BaselineState {
  const next = updateCore(prev, value, cfg, rejectHardOutliers);
  if (!rejectHardOutliers) return next;
  const accepted = next.nValid > (prev?.nValid ?? 0);
  if (!accepted) {
    // Hard-rejected: in range, settled and too far. A run of them on one side is a real step (version 33).
    if (prev && inRange(value, cfg) && prev.nValid >= earlyAdaptNights && Math.abs(value - prev.baseline) > hardOutlierK * prev.spread) {
      const side = value > prev.baseline ? 1 : -1;
      const values = prev.rejected?.side === side ? [...prev.rejected.values, value] : [value];
      if (values.length >= restartAfterRejections) return foldHistory(values, cfg);
      return { ...next, ...(prev.early && { early: prev.early }), rejected: { side, values } };
    }
    // A missing or out-of-range night keeps the early values and any run of rejections.
    return { ...next, ...(prev?.early && { early: prev.early }), ...(prev?.rejected && { rejected: prev.rejected }) };
  }
  if (next.nValid > earlyAdaptNights) return next;
  const early = [...(prev?.early ?? []), value!];
  const k0 = early.length;
  const m = median(early);
  const mad = Math.max(median(early.map((x) => Math.abs(x - m))), floorOf(cfg, m, k0) / 2);
  const kept = early.filter((x) => Math.abs(x - m) <= earlyTrimSigma * 1.4826 * mad);
  const centre = kept.reduce((a, b) => a + b, 0) / kept.length;
  // Deviations from the sample's own mean run short by √((n − 1) / n): corrected, so σ at night 7 is unbiased.
  const k = kept.length;
  const meanDev = kept.reduce((a, x) => a + Math.abs(x - centre), 0) / k;
  const spread = Math.max(floorOf(cfg, centre, k0), k > 1 ? meanDev * Math.sqrt(k / (k - 1)) : meanDev);
  return { ...next, baseline: centre, spread, early };
}

function updateCore(
  prev: BaselineState | null,
  value: number | null,
  cfg: MetricCfg,
  rejectHardOutliers: boolean,
): BaselineState {
  const lb = lambda(cfg.halfLifeB);
  const ls = lambda(cfg.halfLifeS);

  if (prev == null) {
    if (inRange(value, cfg)) return { baseline: value, spread: floorOf(cfg, value, 1), nValid: 1, nightsSinceUpdate: 0, status: "calibrating" };
    const seed = (cfg.minVal + cfg.maxVal) / 2.0;
    return { baseline: seed, spread: floorOf(cfg, seed, 0), nValid: 0, nightsSinceUpdate: 1, status: "calibrating" };
  }

  if (!inRange(value, cfg)) return state(prev.baseline, prev.spread, prev.nValid, prev.nightsSinceUpdate + 1);

  const isYoung = prev.nValid < earlyAdaptNights;

  if (rejectHardOutliers && prev.nValid >= minNightsSeed && !isYoung) {
    if (Math.abs(value - prev.baseline) > hardOutlierK * prev.spread) {
      return state(prev.baseline, prev.spread, prev.nValid, 0);
    }
  }

  // First real value after a placeholder seed.
  if (prev.nValid === 0) {
    return { baseline: value, spread: floorOf(cfg, value, 1), nValid: 1, nightsSinceUpdate: 0, status: "calibrating" };
  }

  const effSpread = isYoung ? prev.spread * earlySpreadInflate : prev.spread;
  const effLb = isYoung ? lambda(earlyHalfLifeB) : lb;
  const lo = prev.baseline - winsorK * effSpread;
  const hi = prev.baseline + winsorK * effSpread;
  const clamped = Math.max(lo, Math.min(hi, value));
  const newBaseline = effLb * clamped + (1.0 - effLb) * prev.baseline;

  // Spread tracks the UNCLAMPED value. With few nights it is the plain mean of the deviations seen so far (the
  // floor seed drops out on night 2); it hands over to the long EWMA once 1/n falls below it (about night 30).
  const absDev = Math.abs(value - newBaseline);
  const effLs = Math.max(ls, 1.0 / prev.nValid);
  const newSpread = Math.max(floorOf(cfg, newBaseline, prev.nValid + 1), effLs * absDev + (1.0 - effLs) * prev.spread);
  return state(newBaseline, newSpread, prev.nValid + 1, 0);
}

/**
 * Illness hold (SCORING_VERSION 30): Recovery's baselines skip a night that continues a run of illness-ward nights, so a
 * sickness isn't absorbed into "normal". Folding every night made the week after a 21-night illness read 82 % green
 * (32 % before it) and the illness itself fade from red. A night is illness-ward when zc = (−z_HRV + z_RHR) / 2 against
 * the prior baselines is at least `zOn`; the second night of a run on is held, at most `maxNights` in a row, so a
 * lasting change is still absorbed. Holding single nights biased healthy people (mean 56 → 50); a cap of 14 let a
 * 21-night illness back in. docs/algorithms/baselines.md § Why version 30.
 */
export const illnessHold = { zOn: 1.0, minRun: 2, maxNights: 21 };

export type HoldState = { run: number; held: number };
export const noHold: HoldState = { run: 0, held: 0 };

/** The next hold state for a night's illness-ward composite (null: not measurable, which breaks a run). */
export function nextHold(prev: HoldState, zc: number | null): HoldState & { hold: boolean } {
  const c = illnessHold;
  const run = zc != null && zc >= c.zOn ? prev.run + 1 : 0;
  const held = run === 0 ? 0 : prev.held;
  const hold = run >= c.minRun && held < c.maxNights;
  return { run, held: hold ? held + 1 : held, hold };
}

/**
 * zc = (−z_HRV + z_RHR) / 2 against usable baselines past their first week, or null when either is missing, not usable
 * or still young (version 32: the robust first week is tighter, and two low first-week nights held the seed's day 7,
 * delaying its first Recovery; a young baseline's z is too uncertain to call a run illness-ward).
 */
export function illnessWardZ(hrv: number | null | undefined, rhr: number | null | undefined, hrvB: BaselineState | null, rhrB: BaselineState | null): number | null {
  if (hrv == null || rhr == null || !hrvB || !rhrB || !isUsable(hrvB) || !isUsable(rhrB)) return null;
  if (hrvB.nValid < earlyAdaptNights || rhrB.nValid < earlyAdaptNights) return null;
  return (-deviation(hrv, hrvB).z + deviation(rhr, rhrB).z) / 2;
}

/** Replay nightly values oldest first; null is a missing night. */
export function foldHistory(values: (number | null)[], cfg: MetricCfg, rejectHardOutliers = true): BaselineState {
  let s: BaselineState | null = null;
  for (const v of values) s = update(s, v, cfg, rejectHardOutliers);
  if (s) return s;
  const seed = (cfg.minVal + cfg.maxVal) / 2.0;
  return { baseline: seed, spread: floorOf(cfg, seed, 0), nValid: 0, nightsSinceUpdate: 0, status: "calibrating" };
}

/** Gaussian σ from the abs-dev spread: 1.253 × spread, floored away from zero. */
export const sigma = (s: BaselineState): number => Math.max(1.253 * s.spread, 1e-9);

/** Shrinks z by nValid / (nValid + zShrinkK): a short history estimates both centre and spread noisily. */
export const zShrinkK = 2;

/** Spread widened by (n + zShrinkK) / n, which shrinks every z drawn from it; fades as nValid grows. */
export const zSpread = (s: BaselineState): number => (s.spread * (s.nValid + zShrinkK)) / Math.max(s.nValid, 1);

/** σ for z-scores and personal ranges: sigma() with the short-history shrink. */
export const zSigma = (s: BaselineState): number => Math.max(1.253 * zSpread(s), 1e-9);

export function deviation(value: number, s: BaselineState): Deviation {
  const z = (value - s.baseline) / zSigma(s);
  const ratio = s.baseline !== 0 ? value / s.baseline - 1.0 : 0.0;
  return { z, delta: value - s.baseline, ratio, inNormalRange: Math.abs(z) <= 1.0 };
}

/** Plain trailing mean and sample SD over the last `window` valid nights; spread stored as SD / 1.253. */
export function rollingMeanSD(values: (number | null)[], cfg: MetricCfg, window = 30): BaselineState {
  const valid = values.filter((v): v is number => inRange(v, cfg));
  if (valid.length === 0) {
    const seed = (cfg.minVal + cfg.maxVal) / 2.0;
    return { baseline: seed, spread: floorOf(cfg, seed, 0), nValid: 0, nightsSinceUpdate: 0, status: "calibrating" };
  }
  const trailing = valid.slice(-window);
  const n = trailing.length;
  const mean = trailing.reduce((a, b) => a + b, 0) / n;
  let sd: number;
  if (n >= 2) {
    let ss = 0;
    for (const v of trailing) ss += (v - mean) * (v - mean);
    sd = Math.sqrt(ss / (n - 1));
  } else {
    sd = floorOf(cfg, mean, n) * 1.253;
  }
  return state(mean, Math.max(floorOf(cfg, mean, n), sd) / 1.253, n, 0);
}

// ── Civil-day arithmetic (replaces java.time) ──────────────────────────────

const parseInt32 = (s: string): number | null => (/^[+-]?\d+$/.test(s) ? Number(s) : null);

/** Days from 1970-01-01 for an ISO `yyyy-MM-dd`, or null if unparseable (Howard Hinnant's algorithm). */
export function isoEpochDay(iso: string): number | null {
  const p = iso.split("-");
  if (p.length !== 3) return null;
  const y = parseInt32(p[0]);
  const m = parseInt32(p[1]);
  const d = parseInt32(p[2]);
  if (y == null || m == null || d == null) return null;
  if (m < 1 || m > 12) return null;
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of isoEpochDay. */
const epochDayToIso = (day: number): string => new Date(day * 86_400_000).toISOString().slice(0, 10);

/** The oldest `yyyy-MM-dd` a carried vital may bear; an unparseable key fails closed to itself. */
export function cutoffKey(todayKey: string, carryDays = vitalCarryDays): string {
  const t = isoEpochDay(todayKey);
  return t == null ? todayKey : epochDayToIso(t - carryDays);
}

/** The newest point if it is still fresh enough to present as "latest". `points` sorted oldest first. */
export function freshestCarried<T>(
  points: [string, T][],
  todayKey: string,
  carryDays = vitalCarryDays,
): [string, T] | null {
  const newest = points.at(-1);
  if (!newest) return null;
  return newest[0] >= cutoffKey(todayKey, carryDays) ? newest : null;
}

/** Calendar days since the newest night with a usable HRV, or null. `dayKeys` and `nightlyHrv` are parallel. */
export function nightsSinceNewestValidNight(
  dayKeys: string[],
  nightlyHrv: (number | null)[],
  today: string,
): number | null {
  let newest: string | null = null;
  for (let i = 0; i < Math.min(dayKeys.length, nightlyHrv.length); i++) {
    if (nightlyHrv[i] == null) continue;
    if (newest == null || dayKeys[i] > newest) newest = dayKeys[i];
  }
  if (newest == null) return null;
  const a = isoEpochDay(newest);
  const b = isoEpochDay(today);
  if (a == null || b == null) return null;
  return b - a >= 0 ? b - a : null;
}

/** Nights observed in the trailing window, and how many of them carried no HRV. */
export function recentHrvCoverage(
  dayKeys: string[],
  nightlyHrv: (number | null)[],
  today: string,
  window = staleDays,
): { observed: number; missing: number } {
  const t = isoEpochDay(today);
  if (t == null) return { observed: 0, missing: 0 };
  let observed = 0;
  let missing = 0;
  for (let i = 0; i < Math.min(dayKeys.length, nightlyHrv.length); i++) {
    const d = isoEpochDay(dayKeys[i]);
    if (d == null || t - d < 0 || t - d >= window) continue;
    observed++;
    if (nightlyHrv[i] == null) missing++;
  }
  return { observed, missing };
}
