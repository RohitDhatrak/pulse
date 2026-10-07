// Own algorithm (docs/algorithms/journal-impact.md): for each journal behaviour, the difference in next-day
// recovery, HRV z-score and sleep performance between "yes" and "no" days over the last 90 days,
// Δ = mean(yes) − mean(no), with a Welch t 90% interval. A difference is "clear" only when it survives a
// Benjamini–Hochberg false-discovery correction across the behaviours of that metric, and "possible" when only its
// own interval excludes 0. Days next to an illness are left out of every other behaviour's comparison.
import { mean } from "../scoring/forecast";
import { benjaminiHochberg, studentTQuantile, studentTTwoSidedP, welchDf } from "./stats";

export const journalImpactConfig = {
  /** Bumped when the method changes, so stored results computed from the same inputs are redone. */
  version: 2,
  /** Behaviour days looked at, ending the day before `asOf` (*tunable*). */
  windowDays: 90,
  /** Minimum "yes" days and minimum "no" days (*tunable*). */
  minDays: 5,
  /** Two-sided interval level: outside it is a "possible" effect. */
  ciLevel: 0.9,
  /** False-discovery rate per metric: a "clear" effect survives Benjamini–Hochberg at this q. */
  fdrQ: 0.1,
  /**
   * Context tags whose days distort every other comparison: a pair (D, D + 1) is left out of the other tags when this
   * tag was answered yes on D or D + 1. The tag itself is still analysed.
   */
  excludeAround: ["illness"] as readonly string[],
};

/** One day's check-in. A tag missing from `tags` was not answered that day. Numbers > 0 count as yes. */
export interface JournalDay {
  day: string;
  tags: Record<string, boolean | number>;
}

/** Scores of the day after a behaviour; null when not available. */
export interface OutcomeDay {
  day: string;
  /** 0–100 */
  recovery: number | null;
  /** HRV z-score against its baseline. */
  hrvZ: number | null;
  /** 0–100 */
  sleepPerf: number | null;
}

export const IMPACT_METRICS = ["recovery", "hrvZ", "sleepPerf"] as const;
export type ImpactMetric = (typeof IMPACT_METRICS)[number];
/**
 * Every metric is higher-is-better, so "positive" is good. "positive" / "negative" are clear (they survive the
 * false-discovery correction); "possible_*" only have an interval that excludes 0.
 */
export type ImpactLabel =
  | "positive"
  | "negative"
  | "possible_positive"
  | "possible_negative"
  | "no_clear_effect"
  | "not_enough_data";

export interface Effect {
  nYes: number;
  nNo: number;
  /** mean(yes) − mean(no). */
  delta: number | null;
  meanYes: number | null;
  meanNo: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  /** Two-sided Welch p-value. */
  p: number | null;
  label: ImpactLabel;
}

/** "clear", "possible", or null (no clear effect, or not enough data). */
export const strengthOf = (l: ImpactLabel): "clear" | "possible" | null =>
  l === "positive" || l === "negative" ? "clear" : l === "possible_positive" || l === "possible_negative" ? "possible" : null;

export interface TagImpact {
  tag: string;
  status: "ok" | "not_enough_data";
  /** Answered days in the window, by answer (days next to an `excludeAround` tag left out). */
  nYes: number;
  nNo: number;
  effects: Record<ImpactMetric, Effect>;
}

/** Seeded PRNG (mulberry32); drives the demo seed in server/sources/seed/generate.ts. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** FNV-1a. */
export function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

const variance = (xs: number[], m: number) => xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);

/**
 * Δ, Welch t interval and p for one tag and metric; the label is provisional ("possible" or none) until the
 * per-metric false-discovery step promotes survivors to clear.
 */
export function welchEffect(yes: number[], no: number[]): Effect {
  const n = { nYes: yes.length, nNo: no.length };
  if (yes.length < journalImpactConfig.minDays || no.length < journalImpactConfig.minDays) {
    return { ...n, delta: null, meanYes: null, meanNo: null, ciLow: null, ciHigh: null, p: null, label: "not_enough_data" };
  }
  const meanYes = mean(yes);
  const meanNo = mean(no);
  const delta = meanYes - meanNo;
  const v1 = variance(yes, meanYes) / yes.length;
  const v2 = variance(no, meanNo) / no.length;
  const se = Math.sqrt(v1 + v2);
  let p: number, half: number;
  if (se > 0) {
    const df = welchDf(v1, yes.length, v2, no.length);
    p = studentTTwoSidedP(delta / se, df);
    half = studentTQuantile(1 - journalImpactConfig.ciLevel, df) * se;
  } else {
    // Both arms constant: any difference is exact.
    p = delta === 0 ? 1 : 0;
    half = 0;
  }
  const ciLow = delta - half;
  const ciHigh = delta + half;
  const label: ImpactLabel = ciLow > 0 ? "possible_positive" : ciHigh < 0 ? "possible_negative" : "no_clear_effect";
  return { ...n, delta, meanYes, meanNo, ciLow, ciHigh, p, label };
}

/**
 * Impact of every tag answered in the window (asOf − 90 … asOf − 1), on the next day's outcomes.
 * Sorted: tags with a recovery effect by |Δ recovery| descending, then other analysed tags, then
 * "not enough data"; ties by tag name.
 */
export function journalImpact(entries: JournalDay[], outcomes: OutcomeDay[], asOf: string): TagImpact[] {
  const { windowDays, minDays, fdrQ, excludeAround } = journalImpactConfig;
  const from = addDays(asOf, -windowDays);
  const byDay = new Map(outcomes.map((o) => [o.day, o]));
  const flagged = new Map<string, Set<string>>(excludeAround.map((t) => [t, new Set<string>()]));
  for (const e of entries) for (const [t, set] of flagged) if (Number(e.tags[t]) > 0) set.add(e.day);
  const nearFlag = (tag: string, day: string) => {
    for (const [t, set] of flagged) if (t !== tag && (set.has(day) || set.has(addDays(day, 1)))) return true;
    return false;
  };
  const arms = new Map<string, { yes: (OutcomeDay | undefined)[]; no: (OutcomeDay | undefined)[] }>();
  for (const e of [...entries].sort((a, b) => a.day.localeCompare(b.day))) {
    if (e.day < from || e.day >= asOf) continue;
    const next = byDay.get(addDays(e.day, 1));
    for (const [tag, v] of Object.entries(e.tags)) {
      const a = arms.get(tag) ?? { yes: [], no: [] };
      arms.set(tag, a);
      if (nearFlag(tag, e.day)) continue;
      (Number(v) > 0 ? a.yes : a.no).push(next);
    }
  }
  const values = (days: (OutcomeDay | undefined)[], m: ImpactMetric) =>
    days.map((d) => d?.[m]).filter((v): v is number => v != null);

  const result: TagImpact[] = [...arms].map(([tag, { yes, no }]) => {
    const enough = yes.length >= minDays && no.length >= minDays;
    // Per-metric n never exceeds the tag's, so a tag below the minimum gives "not enough data" everywhere.
    const effects = Object.fromEntries(
      IMPACT_METRICS.map((m) => [m, welchEffect(values(yes, m), values(no, m))]),
    ) as Record<ImpactMetric, Effect>;
    return { tag, status: enough ? "ok" : "not_enough_data", nYes: yes.length, nNo: no.length, effects };
  });

  // Clear effects: Benjamini–Hochberg across this metric's analysed tags.
  for (const m of IMPACT_METRICS) {
    const tested = result.map((t) => t.effects[m]).filter((e) => e.p != null);
    const clear = benjaminiHochberg(tested.map((e) => e.p!), fdrQ);
    tested.forEach((e, i) => {
      if (clear[i]) e.label = e.delta! > 0 ? "positive" : e.delta! < 0 ? "negative" : e.label;
    });
  }

  const rank = (t: TagImpact) =>
    t.status !== "ok" ? -2 : t.effects.recovery.delta == null ? -1 : Math.abs(t.effects.recovery.delta);
  return result.sort((a, b) => rank(b) - rank(a) || a.tag.localeCompare(b.tag));
}
