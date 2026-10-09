// Own algorithm (docs/algorithms/healthspan.md): Pulse Age and Pace of Aging. Each input maps to a log
// hazard ratio through a piecewise-linear dose-response curve pinned from a cited paper. The terms are
// taken against a reference profile, summed and shrunk for overlap, then turned into years with the
// Gompertz doubling time. The method follows noop's VitalityEngine.kt; the curves and the gates are ours.
// Since SCORING_VERSION 14: a missing input counts as a typical person of your age and sex (it used to scale the
// others up by 9 / n), and steps and zones 1–3, which measure the same activity, count once: the larger penalty.
// Since SCORING_VERSION 19 (docs/algorithms/healthspan.md § Why version 19): the reference is a person who meets health guidelines
// (it was a fit person, so almost nobody scored younger); run and daily VO2max are blended by count; activity curves
// apply to rolling 7-day windows; no result before 14 days of activity data; strength is unknown until a workout is
// logged; and the strength, sleep, lean-mass, SRI and resting-HR curves were corrected.
import { isoEpochDay } from "../scoring/baselines";
import { piecewiseLinear, referenceVo2max, vo2maxAtPercentileExtended, type Knots, type Sex } from "./fitnessLevel";

/** Google exercise types that count as strength minutes (pipeline) and the strength icon (queries). */
export const STRENGTH_TYPES = /STRENGTH|WEIGHT|CROSSFIT|CALISTHENICS/;

/** One day's inputs. A null or absent field means no data that day. */
export interface HealthspanDay {
  /** yyyy-MM-dd */
  day: string;
  /** Main-sleep asleep hours. */
  sleepHours?: number | null;
  /** Trailing 7-day SRI on [−100, 100], from sleepRegularityIndex. */
  sri?: number | null;
  /** Minutes in heart-rate-reserve zones 1–3 that day; null unless the band was worn ≥ 10 h awake. */
  zone13Min?: number | null;
  /** Minutes in heart-rate-reserve zones 4–5 that day; null unless worn ≥ 10 h awake. */
  zone45Min?: number | null;
  /** Strength-workout minutes; 0 on a day worn ≥ 10 h awake without one, else null. */
  strengthMin?: number | null;
  steps?: number | null;
  /** `run-vo2-max`, mL/kg/min. */
  vo2maxRun?: number | null;
  /** `daily-vo2-max`, mL/kg/min. */
  vo2maxDaily?: number | null;
  /** Google's daily resting HR, bpm. */
  restingHr?: number | null;
  weightKg?: number | null;
  /** Body fat, 0–100 %. */
  bodyFatPct?: number | null;
}

export interface HealthspanProfile {
  /** Chronological age in years on the evaluation day (fractional is fine). */
  age: number;
  sex: Sex;
  /** Needed for the lean-mass term (fat-free mass index); the term drops without it. */
  heightCm?: number | null;
}

/** [x, HR] rows → [x, ln HR] knots. */
const lnHr = (rows: [number, number][]): Knots => rows.map(([x, hr]) => [x, Math.log(hr)] as const);

/** Sedlmeier 2021 AJCN: FFMI 21.9 vs 16.1 kg/m² → HR 0.70, so ln HR per kg/m². */
const leanSlope = Math.log(0.7) / (21.9 - 16.1);
/** Lean mass per sex: Sedlmeier's slope over ±half its published span (2.9 kg/m²) around that sex's reference. */
const leanCurve = (ref: number): Knots => [
  [ref - 2.9, -leanSlope * 2.9],
  [ref + 2.9, leanSlope * 2.9],
];
/** SRI: Windred's Q1 → Q2 slope continued below the Q1 median down to 50 (version 19; it was flat below 65.1). */
const sriBelowQ1 = (Math.log(0.8) / (75.62 - 65.1)) * (50 - 65.1);

/**
 * Dose-response curves in each input's units, flat beyond the end knots. Only differences from the
 * reference matter, so a curve's own reference point is arbitrary. Sources and approximations are in
 * docs/algorithms/healthspan.md.
 */
export const curves = {
  // mL/kg/min. Kodama 2009 JAMA: RR 0.87 per 1 MET (3.5 mL/kg/min) higher, linear.
  vo2max: lnHr([[10, 1], [80, 0.87 ** (70 / 3.5)]]),
  // bpm. Zhang 2016 CMAJ: RR 1.09 per 10 bpm, linear from 45 bpm.
  restingHr: lnHr([[45, 1], [105, 1.09 ** 6]]),
  // Steps/day. Paluch 2022 Lancet Public Health: quartile medians, HR vs Q1.
  steps: lnHr([[3553, 1], [5801, 0.6], [7842, 0.55], [10901, 0.47]]),
  // Hours. Cappuccio 2010 Sleep: short RR 1.12 at 5 h vs 7–8 h. No long-sleep penalty since version 19: the long-sleep
  // association is widely read as reverse causation, and the study's self-reported hours run longer than wearable
  // time asleep.
  sleepHours: lnHr([[5, 1.12], [7, 1], [8, 1]]),
  // SRI. Windred 2024 Sleep, Tables 1–2 (full model): quintile medians, HR vs Q1; Q1–Q2 slope continued down to 50.
  sri: [[50, sriBelowQ1], ...lnHr([[65.1, 1], [75.62, 0.8], [80.99, 0.75], [85.22, 0.72], [89.8, 0.7]])] as Knots,
  // Min/week. Ekelund 2019 BMJ, Suppl. Table 5: MVPA spline in min/day (× 7 here), HR vs ~0 min/day.
  zone13: lnHr(
    [[0, 1], [2, 0.89], [4, 0.79], [6, 0.7], [8, 0.62], [10, 0.56], [12, 0.5], [14, 0.46], [16, 0.43], [18, 0.41], [20, 0.4], [22, 0.4], [24, 0.39]]
      .map(([perDay, hr]): [number, number] => [perDay * 7, hr]),
  ),
  // Min/week. Lee 2022 Circulation, vigorous adjusted for moderate: 75–149 → 0.81, 150–299 → 2–4 % lower,
  // ≥ 300 no further benefit; at category midpoints (approximation).
  zone45: lnHr([[0, 1], [112, 0.81], [225, 0.81 * 0.97]]),
  // Min/week. Momma 2022 BJSM: nadir RR 0.83 at 40 min/week. Flat above since version 19: the J-shaped upturn is
  // "unclear" to its authors, and it scored 140+ min/week like no strength at all.
  strength: lnHr([[0, 1], [40, 0.83]]),
  // Fat-free mass index, kg/m²: per sex (see `curveFor`); this is the men's.
  leanMass: leanCurve(18.9),
} satisfies Record<string, Knots>;

export type HealthspanInput = keyof typeof curves;

/** The activity inputs: scored on rolling 7-day windows. */
const ACTIVITY = ["zone13", "zone45", "strength", "steps"] as const satisfies readonly HealthspanInput[];
type ActivityInput = (typeof ACTIVITY)[number];
const ACTIVITY_FIELD: Record<ActivityInput, "zone13Min" | "zone45Min" | "strengthMin" | "steps"> = {
  zone13: "zone13Min",
  zone45: "zone45Min",
  strength: "strengthMin",
  steps: "steps",
};

export const healthspanConfig = {
  /** Shrink on Σ ln HR for correlated inputs (*tunable*; noop VitalityEngine.kt uses 0.75). */
  overlapShrink: 0.75,
  /** Gompertz mortality-rate doubling time, years (Finch et al. 1990: about 8). */
  doublingYears: 8,
  /** Pulse Age = age ± at most this (*tunable*). */
  clampYears: 15,
  /** S in Pace = 1 + (Δ30d − Δ6mo) / S (*tunable*). */
  paceScaleYears: 5,
  paceMin: -1,
  paceMax: 3,
  /** VO2max weight with daily estimates only (*tunable*): Google's estimate leans on resting HR, already a term. */
  dailyVo2maxWeight: 0.5,
  /**
   * Run readings count against this many daily-mean "readings" of prior (version 19): value = (n·run + k·daily) /
   * (n + k), weight = 0.5 + 0.5·n / (n + k). One reading moves VO2max a quarter of the way and adds 0.125 weight; it
   * used to replace six months of estimates outright. k = 2 let one low reading move Pulse Age 0.6 years.
   */
  vo2maxRunPrior: 3,
  ageWindowDays: 180,
  paceWindowDays: 30,
  /**
   * Pace's 30-day window (version 28): an activity input with fewer days than this keeps its 6-month term, as the
   * 6-month window needs `minActivityDays`. One worn day used to become the month's weekly activity, so a month of
   * night-only wear swung Pace from 0.7 to 2.7 with habits unchanged.
   */
  paceMinActivityDays: 14,
  /**
   * From the gate up, the 30-day activity term is pulled toward the 6-month one with weight
   * [n / (n + k)] / [30 / (30 + k)] for n days, capped at 1 (version 28): a fully worn month counts in full, 14 days
   * at 0.57, 20 at 0.75. A partly worn month's 7-day windows are noisy; plain n / (n + k) also damped real changes.
   */
  paceShrinkDays: 60,
  /**
   * Strength's ln HR is weighted n / (n + this) for n logged strength workouts in the 6 months (version 29). The
   * reference (40 min/week) is the curve's nadir, so the term can only add years, and every worn day after the first
   * log counts as 0 without one: a single logged session added about 1.5 years, then fell away overnight 180 days
   * later. One log now counts 11 %, a weekly habit (26) 76 %. 4 left one log at +0.3; 12 hid a low, logged habit.
   */
  strengthLogPrior: 8,
  /** Activity curves are applied per trailing window of this many days, then averaged (version 19). */
  activityWindowDays: 7,
  /** A rolling window needs at least this many days with the input. */
  minWindowDays: 4,
  /** Fewer days with any input → provisional. */
  minDays: 20,
  /** Fewer days with zone data in the 6 months → no result yet (version 19; it showed from day 1). */
  minActivityDays: 14,
  /** Fewer measured terms → no result: too much of Pulse Age would be the typical profile (*tunable*). */
  minTerms: 5,
  /**
   * Paluch 2022: steps beyond the plateau earn nothing (< 60: 8–10k; ≥ 60: 6–8k). The upper ends are the cap and the
   * lower ends the reference, each ramped linearly between ages 55 and 65 (version 19; it stepped at 60).
   */
  steps: { cap: [10_000, 8_000], reference: [8_000, 6_000], rampAges: [55, 65] },
  /** The reference profile besides VO2max and steps: a person who meets health guidelines (version 19). */
  reference: {
    restingHr: { male: 60, female: 64 },
    sleepHours: 7.5,
    sri: 81.0,
    zone13: 100,
    zone45: 15,
    strength: 40,
    leanMass: { male: 18.9, female: 15.4 },
  },
  /** A typical person, used only for a missing input (sources in the doc). Zones and strength are the reference. */
  typical: {
    vo2maxPercentile: 50,
    restingHr: { male: 65, female: 68 },
    steps: 6_800,
    sleepHours: 7.0,
    sri: 81.0,
  },
};

/** Linear from a at the first age to b at the second, flat outside. */
const ageRamp = (age: number, [a, b]: number[]) => {
  const [lo, hi] = healthspanConfig.steps.rampAges;
  return age <= lo ? a : age >= hi ? b : a + ((b - a) * (age - lo)) / (hi - lo);
};
/** The step count above which more steps earn nothing, at this age. */
export const stepsCap = (age: number) => ageRamp(age, healthspanConfig.steps.cap);

/** The input's curve for this sex (only lean mass differs). */
export const curveFor = (key: HealthspanInput, sex: Sex): Knots =>
  key === "leanMass" ? leanCurve(healthspanConfig.reference.leanMass[sex]) : curves[key];

/** The profile that scores Pulse Age = chronological age: a person meeting health guidelines (version 19). */
export function referenceProfile(age: number, sex: Sex): Record<HealthspanInput, number> {
  const r = healthspanConfig.reference;
  return {
    vo2max: referenceVo2max(age, sex),
    restingHr: r.restingHr[sex],
    steps: ageRamp(age, healthspanConfig.steps.reference),
    sleepHours: r.sleepHours,
    sri: r.sri,
    zone13: r.zone13,
    zone45: r.zone45,
    strength: r.strength,
    leanMass: r.leanMass[sex],
  };
}

/** The profile a missing input is scored as: a typical person of this age and sex. */
export function typicalProfile(age: number, sex: Sex): Record<HealthspanInput, number> {
  const t = healthspanConfig.typical;
  const ref = referenceProfile(age, sex);
  return {
    vo2max: vo2maxAtPercentileExtended(age, sex, t.vo2maxPercentile),
    restingHr: t.restingHr[sex],
    steps: t.steps,
    sleepHours: t.sleepHours,
    sri: t.sri,
    zone13: ref.zone13,
    zone45: ref.zone45,
    strength: ref.strength,
    leanMass: ref.leanMass, // Schutz 2002's median is the reference already
  };
}

export interface HealthspanContribution {
  key: HealthspanInput;
  /** The window's value, in the curve's units (weekly minutes for zones and strength, FFMI for lean mass). */
  value: number;
  reference: number;
  /** Signed years added to Pulse Age (shrunk; they sum to the unclamped Δage). */
  years: number;
  /** No data in the window: `value` is the typical profile's. */
  estimated?: true;
  /** Steps or zones 1–3 whose penalty is not counted, because the other one, the larger, already counts it. */
  overlapped?: true;
  /** Strength with no workout logged in the 6 months: unknown, so 0 years (version 19). Days before the first logged
   * workout are left out once there is one. */
  unlogged?: true;
  /** Strength: workouts logged in the 6 months, which weight the term n / (n + strengthLogPrior) (version 29). */
  strengthLogs?: number;
}

export interface HealthspanResult {
  pulseAge: number;
  /** Pulse Age − age, clamped to ±clampYears. */
  deltaYears: number;
  paceOfAging: number;
  /** For the 6-month window. */
  contributions: HealthspanContribution[];
  /** "blend": run readings and daily estimates together; "run" / "daily": only one kind. */
  vo2maxSource: "run" | "daily" | "blend" | null;
  /** Run VO2max readings in the 6-month window. */
  vo2maxRuns: number;
  /** Days in the 6-month window with any input. */
  dataDays: number;
  /** Days in the 6-month window with zone data (worn ≥ 10 h awake). */
  activityDays: number;
  provisional: boolean;
  /** True until the data spans the full 6-month window. */
  paceProvisional: boolean;
  /** Days in the last 30 with zone data; under `paceMinActivityDays`, Pace leaves activity at its 6-month value. */
  paceActivityDays: number;
  /** Strength workouts logged in the 6 months (version 29). */
  strengthLogs: number;
}

/** One window's terms: the displayed value and the ln HR against the reference, before weights. */
/** `days`: the activity days behind an activity term (for Pace's 30-day gate and shrinkage). */
type Term = { value: number; lnHazard: number; unlogged?: true; days?: number };
export type Terms = Partial<Record<HealthspanInput, Term>>;

const mean = (xs: (number | null | undefined)[]): number | undefined => {
  const v = xs.filter((x): x is number => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
};

/**
 * One window's terms. VO2max blends run readings with the daily mean; activity inputs average their curve over every
 * rolling 7-day window with enough data; the rest take the window mean.
 */
function windowTerms(days: (HealthspanDay & { e: number })[], from: number, to: number, ctx: Ctx): Terms {
  const cfg = healthspanConfig;
  const t: Terms = {};
  const at = (key: HealthspanInput, x: number) => piecewiseLinear(ctx.curve(key), x) - piecewiseLinear(ctx.curve(key), ctx.ref[key]);
  const plain = (key: HealthspanInput, v: number | undefined) => {
    if (v != null) t[key] = { value: v, lnHazard: at(key, v) };
  };

  // VO2max (version 19): run readings calibrate the daily estimate. Over the 6 months, the run mean's gap from the
  // daily mean is shrunk by count (n / (n + k)) and added to this window's daily mean, at weight 0.5 + 0.5·n / (n + k).
  // For the 6-month window that is (n·run + k·daily) / (n + k). Using the 6-month count in the 30-day window too keeps
  // Pace at 1.0 for steady fitness (that window holds fewer runs, which would otherwise weaken the term).
  const daily = mean(days.map((d) => d.vo2maxDaily));
  const runs = mean(days.map((d) => d.vo2maxRun));
  const v = ctx.vo2;
  const value = daily != null ? daily + v.offset : runs ?? (v.runMean ?? undefined);
  if (value != null) t.vo2max = { value, lnHazard: at("vo2max", value) * v.weight };

  plain("restingHr", mean(days.map((d) => d.restingHr)));
  plain("sleepHours", mean(days.map((d) => d.sleepHours)));
  plain("sri", mean(days.map((d) => d.sri)));
  const h2 = ctx.heightCm ? (ctx.heightCm / 100) ** 2 : null;
  if (h2 != null) {
    plain("leanMass", mean(days.map((d) => (d.weightKg != null && d.bodyFatPct != null ? (d.weightKg * (1 - d.bodyFatPct / 100)) / h2 : null))));
  }

  // Activity: the curve per trailing 7-day window, averaged. Applying it to the 6-month mean hid a decline for months
  // (one sedentary month barely moves a 150 min/week mean off the curve's flat part).
  for (const key of ACTIVITY) {
    const field = ACTIVITY_FIELD[key];
    const byDay = new Map<number, number>();
    for (const d of days) {
      const v = d[field];
      if (v != null && Number.isFinite(v)) byDay.set(d.e, v);
    }
    if (!byDay.size) continue;
    if (key === "strength") {
      if (ctx.strengthFrom == null) {
        t.strength = { value: 0, lnHazard: 0, unlogged: true };
        continue;
      }
      // Before the first logged workout, a 0 is unknown, not "no strength": starting to log must not count the months
      // before it against you.
      for (const e of [...byDay.keys()]) if (e < ctx.strengthFrom) byDay.delete(e);
      if (!byDay.size) continue;
    }
    const weekly = (xs: number[]) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return key === "steps" ? Math.min(m, ctx.stepsCap) : m * 7;
    };
    let sum = 0;
    let windows = 0;
    for (let end = from; end <= to; end++) {
      const xs: number[] = [];
      for (let e = end - cfg.activityWindowDays + 1; e <= end; e++) {
        const v = e >= from ? byDay.get(e) : undefined;
        if (v != null) xs.push(v);
      }
      if (xs.length < cfg.minWindowDays) continue;
      sum += at(key, weekly(xs));
      windows++;
    }
    const all = [...byDay.values()];
    const value = key === "steps" ? all.reduce((a, b) => a + b, 0) / all.length : (all.reduce((a, b) => a + b, 0) / all.length) * 7;
    // Too few days for any whole window: the plain window mean, as before.
    const lnHazard = windows ? sum / windows : at(key, key === "steps" ? Math.min(value, ctx.stepsCap) : value);
    // Strength counts in proportion to how much has been logged: a few logs are a weak sign of a habit (version 29).
    const weight = key === "strength" ? ctx.strengthLogs / (ctx.strengthLogs + cfg.strengthLogPrior) : 1;
    t[key] = { value, lnHazard: lnHazard * weight, days: byDay.size };
  }
  return t;
}

/**
 * Pace's 30-day activity terms (version 28): under `paceMinActivityDays` days an input keeps its 6-month term (or is
 * left out of both windows if it has none); from there it is shrunk toward the 6-month term, fully worn counting in
 * full. Other inputs pass through.
 */
export function paceActivity(long: Terms, short: Terms): Terms {
  const cfg = healthspanConfig;
  const out: Terms = { ...short };
  for (const key of ACTIVITY) {
    const s = short[key];
    const l = long[key];
    if (!s || s.unlogged || s.days == null) continue;
    if (s.days < cfg.paceMinActivityDays) {
      if (l) out[key] = l;
      else delete out[key];
      continue;
    }
    if (!l) continue;
    const k = cfg.paceShrinkDays;
    const w = Math.min(1, s.days / (s.days + k) / (cfg.paceWindowDays / (cfg.paceWindowDays + k)));
    out[key] = { ...s, lnHazard: l.lnHazard + w * (s.lnHazard - l.lnHazard) };
  }
  return out;
}

type Ctx = {
  ref: Record<HealthspanInput, number>;
  typical: Record<HealthspanInput, number>;
  curve: (key: HealthspanInput) => Knots;
  heightCm: number | null | undefined;
  stepsCap: number;
  /** VO2max calibration from the 6 months: the run mean's shrunk gap from the daily mean, and the term's weight. */
  vo2: { offset: number; weight: number; runMean: number | null };
  /** Epoch day of the first logged strength workout up to today, or null: none, so strength is unknown. */
  strengthFrom: number | null;
  /** Strength workouts logged in the 6 months: the term's weight is n / (n + strengthLogPrior) (version 29). */
  strengthLogs: number;
};

/**
 * Unclamped Δage and its per-input years, or null below minTerms measured inputs. A missing input counts as the
 * typical profile; steps and zones 1–3 count once (the larger penalty).
 */
function deltaAge(t: Terms, ctx: Ctx) {
  const cfg = healthspanConfig;
  const all = Object.keys(curves) as HealthspanInput[];
  if (all.filter((k) => t[k] != null).length < cfg.minTerms) return null;
  const toYears = cfg.overlapShrink / (Math.LN2 / cfg.doublingYears);
  const contributions = all.map((key): HealthspanContribution => {
    const term = t[key];
    if (term) {
      return {
        key,
        value: term.value,
        reference: ctx.ref[key],
        years: term.lnHazard * toYears,
        ...(term.unlogged && { unlogged: true as const }),
        ...(key === "strength" && !term.unlogged && { strengthLogs: ctx.strengthLogs }),
      };
    }
    // A typical VO2max stands in for the person's unknown true value, so it counts at full weight.
    const x = key === "steps" ? Math.min(ctx.typical[key], ctx.stepsCap) : ctx.typical[key];
    const lnHazard = piecewiseLinear(ctx.curve(key), x) - piecewiseLinear(ctx.curve(key), ctx.ref[key]);
    return { key, value: ctx.typical[key], reference: ctx.ref[key], years: lnHazard * toYears, estimated: true };
  });
  // Steps and zones 1–3 both measure how active you are: when both are penalties, only the larger counts.
  const steps = contributions.find((c) => c.key === "steps")!;
  const zones = contributions.find((c) => c.key === "zone13")!;
  if (steps.years > 0 && zones.years > 0) {
    const smaller = steps.years < zones.years ? steps : zones;
    smaller.years = 0;
    smaller.overlapped = true;
  }
  return { years: contributions.reduce((a, c) => a + c.years, 0), contributions };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

const hasInput = (d: HealthspanDay) => Object.entries(d).some(([k, v]) => k !== "day" && v != null);

/**
 * Pulse Age over the 6 months to `asOf`, and Pace of Aging from the last 30 days against those 6 months,
 * both at today's age. Null with fewer than minActivityDays days of activity data, or fewer than minTerms inputs.
 */
export function healthspan(days: HealthspanDay[], profile: HealthspanProfile, asOf: string): HealthspanResult | null {
  const cfg = healthspanConfig;
  const today = isoEpochDay(asOf);
  if (today == null) return null;
  const dated = days.flatMap((d) => {
    const e = isoEpochDay(d.day);
    return e != null && e <= today ? [{ ...d, e }] : [];
  });
  const sixFrom = today - cfg.ageWindowDays + 1;
  const thirtyFrom = today - cfg.paceWindowDays + 1;
  const six = dated.filter((d) => d.e >= sixFrom);
  const thirty = six.filter((d) => d.e >= thirtyFrom);
  const activityDays = six.filter((d) => d.zone13Min != null).length;
  if (activityDays < cfg.minActivityDays) return null;

  const runReadings = six.map((d) => d.vo2maxRun).filter((x): x is number => x != null && Number.isFinite(x));
  const n = runReadings.length;
  const share = n / (n + cfg.vo2maxRunPrior);
  const runMean = n ? runReadings.reduce((x, y) => x + y, 0) / n : null;
  const daily6 = mean(six.map((d) => d.vo2maxDaily));
  const ctx: Ctx = {
    vo2: {
      offset: runMean != null && daily6 != null ? share * (runMean - daily6) : 0,
      weight: cfg.dailyVo2maxWeight + (1 - cfg.dailyVo2maxWeight) * share,
      runMean,
    },
    ref: referenceProfile(profile.age, profile.sex),
    typical: typicalProfile(profile.age, profile.sex),
    curve: (key) => curveFor(key, profile.sex),
    heightCm: profile.heightCm,
    stepsCap: stepsCap(profile.age),
    // Strength minutes come only from logged workouts: none in 6 months means unknown, not "never lifts"; and days
    // before the first logged one are unknown too.
    strengthFrom: six.some((d) => (d.strengthMin ?? 0) > 0) ? Math.min(...dated.filter((d) => (d.strengthMin ?? 0) > 0).map((d) => d.e)) : null,
    strengthLogs: six.filter((d) => (d.strengthMin ?? 0) > 0).length,
  };
  const long = windowTerms(six, sixFrom, today, ctx);
  // A term with no data lately keeps its 6-month value, so both windows are scored alike.
  const short = { ...long, ...paceActivity(long, windowTerms(thirty, thirtyFrom, today, ctx)) };
  const a = deltaAge(long, ctx);
  const b = deltaAge(short, ctx);
  if (!a || !b) return null;

  const daily = daily6 != null;
  const deltaYears = clamp(a.years, -cfg.clampYears, cfg.clampYears);
  const withData = six.filter(hasInput);
  const first = Math.min(...dated.filter(hasInput).map((d) => d.e));
  return {
    pulseAge: profile.age + deltaYears,
    deltaYears,
    // Unclamped deltas, so a change still shows while Pulse Age sits at the clamp.
    paceOfAging: clamp(1 + (b.years - a.years) / cfg.paceScaleYears, cfg.paceMin, cfg.paceMax),
    contributions: a.contributions,
    vo2maxSource: n && daily ? "blend" : n ? "run" : daily ? "daily" : null,
    vo2maxRuns: n,
    dataDays: withData.length,
    activityDays,
    provisional: withData.length < cfg.minDays,
    paceProvisional: today - first + 1 < cfg.ageWindowDays,
    paceActivityDays: thirty.filter((d) => d.zone13Min != null).length,
    strengthLogs: ctx.strengthLogs,
  };
}
