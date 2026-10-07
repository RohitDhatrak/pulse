import { describe, expect, it } from "vitest";
import { isoEpochDay } from "../scoring/baselines";
import { piecewiseLinear, vo2maxAtPercentile, vo2maxAtPercentileExtended, type Sex } from "./fitnessLevel";
import {
  curveFor,
  curves,
  healthspan,
  healthspanConfig,
  referenceProfile,
  stepsCap,
  typicalProfile,
  type HealthspanDay,
  type HealthspanInput,
  type HealthspanProfile,
} from "./healthspan";

const asOf = "2026-10-02";
const today = isoEpochDay(asOf)!;
const iso = (epochDay: number) => new Date(epochDay * 86_400_000).toISOString().slice(0, 10);
const profile: HealthspanProfile = { age: 35, sex: "male", heightCm: 180 };
const ref = referenceProfile(35, "male");
/** ln HR → years: the 0.75 shrink ÷ (ln 2 / 8). */
const years = (lnHr: number) => (lnHr * 0.75) / (Math.LN2 / 8);
/** Years for an input value against the reference (no weight, no cap). */
const yearsAt = (key: HealthspanInput, x: number, sex: Sex = "male", r = ref) =>
  years(piecewiseLinear(curveFor(key, sex), x) - piecewiseLinear(curveFor(key, sex), r[key]));
/** VO2max weight with n run readings (version 19): 0.5 + 0.5 · n / (n + 3). */
const runWeight = (n: number) => 0.5 + 0.5 * (n / (n + healthspanConfig.vo2maxRunPrior));

/** A day exactly at the reference profile for an age, sex and height (FFMI from 20 % body fat). */
const refDayFor = (age: number, sex: Sex, heightCm: number): Omit<HealthspanDay, "day"> => {
  const r = referenceProfile(age, sex);
  return {
    sleepHours: r.sleepHours,
    sri: r.sri,
    zone13Min: r.zone13 / 7,
    zone45Min: r.zone45 / 7,
    strengthMin: r.strength / 7,
    steps: r.steps,
    vo2maxDaily: r.vo2max,
    restingHr: r.restingHr,
    weightKg: (r.leanMass * (heightCm / 100) ** 2) / 0.8,
    bodyFatPct: 20,
  };
};
const refDay = () => refDayFor(35, "male", 180);
/** `n` days ending today; `f(age)` overrides fields, where `age` is days before today. */
const series = (n: number, f: (daysAgo: number) => Partial<HealthspanDay> = () => ({}), base = refDay): HealthspanDay[] =>
  Array.from({ length: n }, (_, i) => ({ day: iso(today - (n - 1 - i)), ...base(), ...f(n - 1 - i) }));
const run = (days: HealthspanDay[], p: HealthspanProfile = profile) => healthspan(days, p, asOf)!;
const term = (r: ReturnType<typeof run>, key: HealthspanInput) => r.contributions.find((c) => c.key === key)!;

describe("the reference: a person who meets health guidelines (SCORING_VERSION 19)", () => {
  it("the reference profile scores Pulse Age = chronological age at every age, for both sexes", () => {
    for (const sex of ["male", "female"] as const) {
      for (let age = 20; age <= 95; age += 5) {
        const h = sex === "male" ? 180 : 165;
        const r = run(series(180, () => ({}), () => refDayFor(age, sex, h)), { age, sex, heightCm: h });
        expect(r.deltaYears).toBeCloseTo(0, 9);
        for (const c of r.contributions) expect(c.years).toBeCloseTo(0, 9);
        expect(r.paceOfAging).toBeCloseTo(1, 9);
      }
    }
  });

  it("the targets: VO2max median, 8,000 steps (6,000 from 65), 100 + 15 zone minutes, SRI 81, resting HR 60 / 64", () => {
    expect(ref).toEqual({
      vo2max: 42.4, // FRIEND 30–39 median for men (was the 75th percentile, 49.2)
      restingHr: 60,
      steps: 8000,
      sleepHours: 7.5,
      sri: 81,
      zone13: 100,
      zone45: 15,
      strength: 40,
      leanMass: 18.9,
    });
    const f = referenceProfile(35, "female");
    expect([f.vo2max, f.restingHr, f.leanMass]).toEqual([30.2, 64, 15.4]);
  });

  it("steps: the reference and the cap ramp linearly between 55 and 65; no step on a birthday", () => {
    expect([50, 55, 60, 65, 70].map((a) => referenceProfile(a, "male").steps)).toEqual([8000, 8000, 7000, 6000, 6000]);
    expect([50, 55, 60, 65, 70].map(stepsCap)).toEqual([10000, 10000, 9000, 8000, 8000]);
  });

  it("a person with fixed habits never jumps on a birthday (version 18 dropped 0.45 years at 60)", () => {
    const fixed = () => ({ ...refDayFor(45, "male", 180), steps: 9000, vo2maxDaily: 35 });
    let prev = run(series(180, () => ({}), fixed), { age: 20, sex: "male", heightCm: 180 }).deltaYears;
    for (let age = 20.01; age <= 95; age += 0.01) {
      const d = run(series(180, () => ({}), fixed), { age, sex: "male", heightCm: 180 }).deltaYears;
      expect(Math.abs(d - prev)).toBeLessThan(0.01);
      prev = d;
    }
  });

  it("the VO2max reference keeps falling after 75 (FRIEND ends at 70–79) and is floored at 15", () => {
    for (const sex of ["male", "female"] as const) {
      const v = [70, 75, 80, 85, 90, 100].map((a) => referenceProfile(a, sex).vo2max);
      for (let i = 1; i < v.length; i++) expect(v[i]).toBeLessThanOrEqual(v[i - 1]);
      expect(v[2]).toBeLessThan(v[1]); // 80 below 75 (version 18: frozen at the 75 value)
      expect(Math.min(...v)).toBeGreaterThanOrEqual(15);
    }
    expect(vo2maxAtPercentileExtended(85, "male", 50)).toBeCloseTo(24.4 + ((24.4 - 28.2) / 10) * 10, 10);
    expect(vo2maxAtPercentileExtended(100, "female", 50)).toBe(15);
    // Up to 75 it is the plain lookup.
    expect(vo2maxAtPercentileExtended(62, "male", 50)).toBe(vo2maxAtPercentile(62, "male", 50));
  });
});

describe("each input", () => {
  it("higher resting HR raises it: +10 bpm is ln 1.09; women are measured against 64", () => {
    expect(run(series(180, () => ({ restingHr: 70 }))).deltaYears).toBeCloseTo(years(Math.log(1.09)), 10);
    const w: HealthspanProfile = { age: 35, sex: "female", heightCm: 165 };
    const fRef = () => refDayFor(35, "female", 165);
    expect(run(series(180, () => ({ restingHr: 64 }), fRef), w).deltaYears).toBeCloseTo(0, 10);
    expect(run(series(180, () => ({ restingHr: 74 }), fRef), w).deltaYears).toBeCloseTo(years(Math.log(1.09)), 10);
  });

  it("steps earn up to the cap and nothing beyond", () => {
    const at = (s: number) => term(run(series(180, () => ({ steps: s }))), "steps").years;
    expect(at(8000)).toBeCloseTo(0, 10);
    expect(at(10000)).toBeCloseTo(yearsAt("steps", 10000), 10);
    expect(at(10000)).toBeLessThan(-0.5); // version 18: steps could never subtract
    expect(at(15000)).toBeCloseTo(at(10000), 10);
    expect(at(5000)).toBeGreaterThan(0);
  });

  it("strength is flat from 40 min/week: 2 h a week no longer scores like none (version 18: J-shape)", () => {
    const at = (m: number) => term(run(series(180, () => ({ strengthMin: m / 7 }))), "strength").years;
    expect(at(40)).toBeCloseTo(0, 10);
    for (const m of [60, 120, 140, 300]) expect(at(m)).toBeCloseTo(0, 10);
    expect(at(20)).toBeCloseTo(yearsAt("strength", 20), 10);
    expect(at(20)).toBeGreaterThan(0);
  });

  it("sleep: no long-sleep penalty; short sleep unchanged", () => {
    for (const h of [7, 7.5, 8, 9, 10]) expect(term(run(series(180, () => ({ sleepHours: h }))), "sleepHours").years).toBeCloseTo(0, 10);
    expect(term(run(series(180, () => ({ sleepHours: 5 }))), "sleepHours").years).toBeCloseTo(years(Math.log(1.12)), 10);
  });

  it("SRI keeps rising in risk below 65 down to 50, then flat (version 18: flat below 65.1)", () => {
    const at = (s: number) => term(run(series(180, () => ({ sri: s }))), "sri").years;
    expect(at(81)).toBeCloseTo(0, 10);
    expect(at(65.1)).toBeGreaterThan(at(75));
    expect(at(50)).toBeGreaterThan(at(65.1));
    expect(at(40)).toBeCloseTo(at(50), 10);
    // The Q1–Q2 slope continued: 65.1 → 50 adds as much per SRI point as 75.62 → 65.1 does.
    const perPoint = (at(65.1) - at(75.62)) / (75.62 - 65.1);
    expect((at(50) - at(65.1)) / 15.1).toBeCloseTo(perPoint, 10);
  });

  it("lean mass is per sex and symmetric around each reference: women's low lean mass now counts", () => {
    const w: HealthspanProfile = { age: 40, sex: "female", heightCm: 165 };
    const lean = (ffmi: number, p: HealthspanProfile) => {
      const h2 = (p.heightCm! / 100) ** 2;
      return term(run(series(180, () => ({ weightKg: 70, bodyFatPct: 100 * (1 - (ffmi * h2) / 70) }), () => refDayFor(p.age, p.sex, p.heightCm!)), p), "leanMass").years;
    };
    expect(lean(15.4, w)).toBeCloseTo(0, 9);
    expect(lean(12.5, w)).toBeGreaterThan(0); // version 18: 0 for any woman below FFMI 16.1
    expect(lean(14.4, w)).toBeCloseTo(-lean(16.4, w), 9);
    expect(lean(12.5, w)).toBeCloseTo(years(-Math.log(0.7) / 2), 9); // half Sedlmeier's span below the median
    expect(lean(10, w)).toBeCloseTo(lean(12.5, w), 9); // flat beyond ±2.9
    const m: HealthspanProfile = { age: 40, sex: "male", heightCm: 180 };
    expect(lean(18.9, m)).toBeCloseTo(0, 9);
    expect(lean(16.0, m)).toBeCloseTo(lean(12.5, w), 9); // the same span either side for both sexes
  });

  it("contributions sum to the unclamped Δage", () => {
    const r = run(series(180, () => ({ restingHr: 66, steps: 6000, sleepHours: 6, sri: 70 })));
    expect(r.contributions.reduce((a, c) => a + c.years, 0)).toBeCloseTo(r.deltaYears, 10);
  });
});

describe("VO2max: run readings blended with daily estimates by count (SCORING_VERSION 19)", () => {
  const daily = 40;
  const withRuns = (runs: Record<number, number>) => run(series(180, (ago) => ({ vo2maxDaily: daily, vo2maxRun: runs[ago] ?? null })));

  it.each([
    [0, {}, 40, 0.5],
    [1, { 10: 46 }, (46 + 3 * 40) / 4, 0.625],
    [3, { 10: 46, 40: 46, 70: 46 }, (3 * 46 + 3 * 40) / 6, 0.75],
  ] as const)("%i run readings: hand-computed value and weight", (n, runs, value, weight) => {
    const r = withRuns(runs);
    expect(r.vo2maxRuns).toBe(n);
    expect(r.vo2maxSource).toBe(n ? "blend" : "daily");
    const v = term(r, "vo2max");
    expect(v.value).toBeCloseTo(value, 10);
    expect(runWeight(n)).toBeCloseTo(weight, 10);
    expect(v.years).toBeCloseTo(yearsAt("vo2max", value) * weight, 10);
  });

  it("one plausible reading (±6 of the daily estimate) moves Pulse Age at most 0.5 years (version 18: up to 2.2)", () => {
    const base = withRuns({}).deltaYears;
    for (const reading of [34, 38, 42, 46]) expect(Math.abs(withRuns({ 5: reading }).deltaYears - base)).toBeLessThan(0.5);
    // A wild one moves it a third of the way, at a third more weight: bounded, not a switch.
    expect(Math.abs(withRuns({ 5: 25 }).deltaYears - base)).toBeLessThan(1.5);
  });

  it("no cliff when a reading turns 90 days old (version 18 switched back to daily at 90 days)", () => {
    expect(withRuns({ 90: 46 }).deltaYears).toBeCloseTo(withRuns({ 91: 46 }).deltaYears, 10);
  });

  it("many runs: the value approaches the run mean and the weight approaches 1", () => {
    const runs = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [i * 3, 50]));
    const v = term(withRuns(runs), "vo2max");
    expect(v.value).toBeCloseTo((60 * 50 + 3 * 40) / 63, 10);
    expect(v.value).toBeGreaterThan(49.5);
    expect(runWeight(60)).toBeGreaterThan(0.97);
  });

  it("steady fitness with a monthly run keeps Pace at 1.0 (the 30-day window uses the 6-month calibration)", () => {
    const r = withRuns({ 0: 46, 30: 46, 60: 46, 90: 46, 120: 46, 150: 46 });
    expect(r.paceOfAging).toBeCloseTo(1, 10);
    // …while a 30-day drop in the daily estimate still moves it.
    const drop = run(series(180, (ago) => ({ vo2maxDaily: ago < 30 ? 36 : 40, vo2maxRun: ago % 30 === 0 ? 46 : null })));
    expect(drop.paceOfAging).toBeGreaterThan(1);
  });

  it("runs without daily estimates: the run mean, at the count's weight", () => {
    const r = run(series(180, (ago) => ({ vo2maxDaily: null, vo2maxRun: ago % 30 === 0 ? 46 : null })));
    expect(r.vo2maxSource).toBe("run");
    expect(term(r, "vo2max").value).toBe(46);
    expect(term(r, "vo2max").years).toBeCloseTo(yearsAt("vo2max", 46) * runWeight(6), 10);
  });

  it("no VO2max at all counts as the FRIEND median (= the reference now), at full weight: 0 years", () => {
    const r = run(series(180, () => ({ vo2maxDaily: null })));
    expect(r.vo2maxSource).toBeNull();
    expect(term(r, "vo2max")).toMatchObject({ estimated: true, years: 0 });
    expect(term(r, "vo2max").value).toBeCloseTo(vo2maxAtPercentile(35, "male", 50), 10);
  });
});

describe("activity on rolling 7-day windows (SCORING_VERSION 19)", () => {
  it("a hand-computed 14-day case: the curve is applied per window, then averaged", () => {
    // Days 1–7: no zone time; days 8–14: 150 min/week. Windows end on days 4–14 (≥ 4 days each).
    const days = series(14, (ago) => ({ zone13Min: ago < 7 ? 150 / 7 : 0 }));
    const r = run(days);
    const lnAt = (w: number) => piecewiseLinear(curves.zone13, w) - piecewiseLinear(curves.zone13, 100);
    const windows: number[] = [];
    for (let end = 1; end <= 14; end++) {
      const inWin = Array.from({ length: 7 }, (_, k) => end - k).filter((d) => d >= 1);
      if (inWin.length < 4) continue;
      const weekly = (inWin.filter((d) => d >= 8).length * 150) / inWin.length;
      windows.push(lnAt(weekly));
    }
    expect(windows).toHaveLength(11);
    expect(term(r, "zone13").years).toBeCloseTo(years(windows.reduce((a, b) => a + b, 0) / windows.length), 10);
    // The 14-day mean (75 min/week) through the curve, as version 18 did, is smaller: one bad week counts more now.
    expect(term(r, "zone13").years).toBeGreaterThan(yearsAt("zone13", 75));
    expect(term(r, "zone13").value).toBeCloseTo(75, 10); // the displayed value is still the mean
  });

  it("a weekend warrior (one 150-minute session a week) scores like the same minutes spread daily", () => {
    const spread = term(run(series(180, () => ({ zone13Min: 150 / 7 }))), "zone13").years;
    const warrior = term(run(series(180, (ago) => ({ zone13Min: ago % 7 === 0 ? 150 : 0 }))), "zone13").years;
    expect(Math.abs(warrior - spread)).toBeLessThan(0.1);
  });

  it("alternating 300 / 0 weeks score worse than a steady 150", () => {
    const steady = term(run(series(182, () => ({ zone13Min: 150 / 7 }))), "zone13").years;
    const swings = term(run(series(182, (ago) => ({ zone13Min: Math.floor(ago / 7) % 2 ? 0 : 300 / 7 }))), "zone13").years;
    expect(swings).toBeGreaterThan(steady + 0.5);
  });

  it("windows with fewer than 4 days of data are skipped; with none, the plain mean is used", () => {
    // Data on 3 days of every 7: no window qualifies.
    const r = run(series(180, (ago) => ({ zone13Min: ago % 7 < 3 ? 50 / 3 : null })));
    // The mean over days with data, × 7: 116.7 min/week.
    expect(term(r, "zone13").years).toBeCloseTo(yearsAt("zone13", (50 / 3) * 7), 10);
  });

  it("steps are capped per window before the curve", () => {
    // 20,000 one week, 4,000 the next: the cap stops the good week offsetting the bad one.
    const r = run(series(182, (ago) => ({ steps: Math.floor(ago / 7) % 2 ? 4000 : 20000 })));
    expect(term(r, "steps").years).toBeGreaterThan(yearsAt("steps", 10000));
    expect(Math.abs(term(r, "steps").value - 12000)).toBeLessThan(200); // 180 of the 182 days
  });
});

describe("gates", () => {
  it("no result before 14 days of activity data (version 18 showed from day 1)", () => {
    expect(healthspan(series(13), profile, asOf)).toBeNull();
    const r = run(series(14));
    expect(r.activityDays).toBe(14);
    expect(r.provisional).toBe(true);
    // Days without zone data (not worn ≥ 10 h awake) don't count towards it.
    expect(healthspan(series(30, (ago) => (ago >= 13 ? { zone13Min: null } : {})), profile, asOf)).toBeNull();
  });

  it("is provisional below 20 days of data", () => {
    expect(run(series(19)).provisional).toBe(true);
    expect(run(series(20)).provisional).toBe(false);
    expect(run(series(20)).dataDays).toBe(20);
  });

  it("is null below minTerms inputs or for a bad date", () => {
    const sparse = series(30, () => ({ sri: null, sleepHours: null, vo2maxDaily: null, restingHr: null }));
    expect(healthspan(sparse, { ...profile, heightCm: null }, asOf)).toBeNull();
    expect(healthspan(series(30), profile, "not-a-day")).toBeNull();
  });

  it("ignores days after asOf and before the 6-month window", () => {
    const later = { day: iso(today + 1), ...refDay(), restingHr: 120 };
    const older = { day: iso(today - 200), ...refDay(), restingHr: 120 };
    expect(run([older, ...series(180), later]).deltaYears).toBeCloseTo(0, 10);
  });

  it("clamps to ±15 years", () => {
    const awful = { vo2maxDaily: 12, restingHr: 105, steps: 1500, sleepHours: 4, sri: 40, zone13Min: 0, zone45Min: 0, strengthMin: 0, weightKg: 120, bodyFatPct: 50 };
    const bad = run(series(180, (ago) => ({ ...awful, strengthMin: ago === 3 ? 10 : 0 })));
    expect(bad.deltaYears).toBe(15);
    expect(bad.pulseAge).toBe(50);
  });
});

describe("strength is unknown until a workout is logged (SCORING_VERSION 19)", () => {
  it("no strength minutes in 6 months: 0 years and marked unlogged", () => {
    const r = run(series(180, () => ({ strengthMin: 0 })));
    expect(term(r, "strength")).toMatchObject({ years: 0, unlogged: true, value: 0 });
  });

  it("one logged session: the weeks without strength count as 0 minutes", () => {
    const r = run(series(180, (ago) => ({ strengthMin: ago === 100 ? 45 : 0 })));
    expect(term(r, "strength").unlogged).toBeUndefined();
    expect(term(r, "strength").years).toBeGreaterThan(1);
  });

  it("days before the first logged workout are unknown: starting to log doesn't count the months before against you", () => {
    // 150 days with no strength logged, then 40 min/week (two 20-minute sessions) for the last 30 days.
    const r = run(series(180, (ago) => ({ strengthMin: ago < 30 && ago % 7 < 2 ? 20 : 0 })));
    // Only the last 30 days count: 40 min/week, the reference, 0 years. Counting the 150 earlier days as 0 would add
    // most of the 1.6-year no-strength penalty.
    expect(term(r, "strength").years).toBeCloseTo(0, 1);
    expect(term(r, "strength").unlogged).toBeUndefined();
  });

  it("never worn for activity (all null): missing, so typical (= the reference, 0 years)", () => {
    const r = run(series(180, () => ({ strengthMin: null })));
    expect(term(r, "strength")).toMatchObject({ years: 0, estimated: true });
  });
});

describe("missing inputs count as a typical person", () => {
  it("typical profile: FRIEND median VO2max, resting HR 65 / 68, 6,800 steps, 7 h, SRI 81, the reference elsewhere", () => {
    for (const [age, sex] of [[35, "male"], [52, "female"], [71, "male"], [88, "female"]] as const) {
      const t = typicalProfile(age, sex);
      const r = referenceProfile(age, sex);
      expect(t.vo2max).toBeCloseTo(vo2maxAtPercentileExtended(age, sex, 50), 10);
      expect([t.restingHr, t.steps, t.sleepHours, t.sri]).toEqual([sex === "male" ? 65 : 68, 6800, 7, 81]);
      expect([t.zone13, t.zone45, t.strength, t.leanMass]).toEqual([r.zone13, r.zone45, r.strength, r.leanMass]);
    }
  });

  it("each missing input adds exactly its typical value's years, and is marked estimated", () => {
    const r = run(series(180, () => ({ sri: null, sleepHours: null, restingHr: null })), { ...profile, heightCm: null });
    expect(r.contributions.filter((c) => c.estimated).map((c) => c.key).sort()).toEqual(["leanMass", "restingHr", "sleepHours", "sri"]);
    expect(term(r, "restingHr").years).toBeCloseTo(yearsAt("restingHr", 65), 10);
    expect(term(r, "sri").years).toBeCloseTo(0, 10); // 81 is the reference now
    expect(r.deltaYears).toBeCloseTo(yearsAt("restingHr", 65), 10);
  });
});

describe("steps and zones 1–3 count once", () => {
  it("an inactive person (3,000 steps, no zone time) gets the larger penalty only", () => {
    const r = run(series(180, () => ({ steps: 3000, zone13Min: 0 })));
    const zones = yearsAt("zone13", 0);
    const steps = yearsAt("steps", 3000);
    expect(zones).toBeGreaterThan(steps);
    expect(term(r, "zone13").years).toBeCloseTo(zones, 10);
    expect(term(r, "steps")).toMatchObject({ years: 0, overlapped: true });
  });

  it("a bonus is never dropped: only two penalties overlap", () => {
    const r = run(series(180, () => ({ steps: 3000, zone13Min: 200 / 7 })));
    expect(term(r, "zone13").years).toBeLessThan(0);
    expect(term(r, "steps").years).toBeCloseTo(yearsAt("steps", 3000), 10);
    expect(r.contributions.some((c) => c.overlapped)).toBe(false);
  });
});

describe("Pace of Aging", () => {
  it("flat inputs give 1.0", () => {
    expect(run(series(180, () => ({ restingHr: 68, steps: 7000 }))).paceOfAging).toBeCloseTo(1, 10);
  });

  it("an input missing in the last 30 days keeps its 6-month value, so flat stays 1.0", () => {
    const r = run(series(180, (ago) => (ago < 30 ? { weightKg: null, bodyFatPct: null } : {})));
    expect(r.paceOfAging).toBeCloseTo(1, 10);
  });

  it("improving the last 30 days gives < 1, worsening gives > 1", () => {
    const better = run(series(180, (ago) => ({ restingHr: ago < 30 ? 50 : 60 })));
    // 6-month mean 58.33 bpm vs 30-day 50 bpm.
    expect(better.paceOfAging).toBeCloseTo(1 + (years(-Math.log(1.09)) - years((-10 / 60) * Math.log(1.09))) / 5, 10);
    expect(run(series(180, (ago) => ({ restingHr: ago < 30 ? 75 : 60 }))).paceOfAging).toBeGreaterThan(1);
  });

  it("stays within [−1, 3]", () => {
    const awful = { vo2maxDaily: 15, restingHr: 100, steps: 2000, sleepHours: 4, sri: 40, zone13Min: 0, zone45Min: 0 };
    const great = { vo2maxDaily: 70, restingHr: 45, zone13Min: 60, zone45Min: 60, sri: 95 };
    expect(run(series(180, (ago) => (ago < 30 ? great : awful))).paceOfAging).toBe(-1);
    expect(run(series(180, (ago) => (ago < 30 ? awful : great))).paceOfAging).toBe(3);
  });

  it("is provisional until the data spans 6 months", () => {
    expect(run(series(179)).paceProvisional).toBe(true);
    expect(run(series(180)).paceProvisional).toBe(false);
  });
});

describe("dose-response curves", () => {
  const sweep = (key: HealthspanInput, sex: Sex, from: number, to: number) => {
    const xs = Array.from({ length: 401 }, (_, i) => from + ((to - from) * i) / 400);
    const k = curveFor(key, sex);
    return xs.slice(1).map((x, i) => ({ x, d: piecewiseLinear(k, x) - piecewiseLinear(k, xs[i]) }));
  };
  const span = (key: HealthspanInput, sex: Sex) => {
    const k = curveFor(key, sex);
    const lo = k[0][0];
    const hi = k[k.length - 1][0];
    return [lo - (hi - lo) * 0.2, hi + (hi - lo) * 0.2] as const;
  };

  it.each(["vo2max", "steps", "sri", "zone13", "zone45", "leanMass", "strength"] as const)("%s never raises hazard as it rises", (key) => {
    for (const sex of ["male", "female"] as const) {
      const s = sweep(key, sex, ...span(key, sex));
      for (const { d } of s) expect(d).toBeLessThanOrEqual(1e-12);
      expect(s.some(({ d }) => d < 0)).toBe(true);
    }
  });

  it("restingHr never lowers hazard as it rises; sleep falls to 7 h and is flat after", () => {
    for (const { d } of sweep("restingHr", "male", 30, 120)) expect(d).toBeGreaterThanOrEqual(-1e-12);
    for (const { x, d } of sweep("sleepHours", "male", 3, 12)) {
      if (x <= 7.03) expect(d).toBeLessThanOrEqual(1e-12);
      else expect(d).toBeCloseTo(0, 12);
    }
  });

  it("is flat beyond the end knots", () => {
    for (const key of Object.keys(curves) as HealthspanInput[]) {
      const k = curveFor(key, "female");
      expect(piecewiseLinear(k, k[0][0] - 100)).toBe(k[0][1]);
      expect(piecewiseLinear(k, k[k.length - 1][0] + 1e6)).toBe(k[k.length - 1][1]);
    }
  });
});

// ── Simulations (deterministic; docs/handoff/pulse-age-issues.md and docs/algorithms/healthspan.md) ─────────────────
function rng(seed: number) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648), x / 2147483648);
  const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
  return { rnd, g };
}
type Habits = { rhr: number; steps: number; sleep: number; sri: number; z13: number; z45: number; str: number; vo2: number };
const active: Habits = { rhr: 60, steps: 8500, sleep: 7.1, sri: 80, z13: 150, z45: 30, str: 60, vo2: 45 };
const sedentary: Habits = { ...active, z13: 0, z45: 0, steps: 4000, str: 0 };
/** A noisy day of someone with these habits: 4 workouts and 2 strength sessions a week, weekly weigh-ins. */
function noisyDay(epoch: number, h: Habits, r: ReturnType<typeof rng>): HealthspanDay {
  const dow = ((epoch % 7) + 7) % 7;
  const workout = h.z13 > 0 && [0, 2, 4, 5].includes(dow);
  const d: HealthspanDay = {
    day: iso(epoch),
    steps: Math.max(500, h.steps * Math.exp(0.35 * r.g() - 0.06)),
    sleepHours: Math.max(3, h.sleep + 0.7 * r.g()),
    sri: Math.min(98, h.sri + 4 * r.g()),
    restingHr: h.rhr + 2.5 * r.g(),
    zone13Min: workout ? (h.z13 / 4) * (0.7 + 0.6 * r.rnd()) : 0,
    zone45Min: workout ? (h.z45 / 4) * (0.5 + r.rnd()) : 0,
    strengthMin: h.str > 0 && [1, 3].includes(dow) ? h.str / 2 : 0,
    vo2maxDaily: h.vo2 + 0.5 * r.g(),
  };
  if (dow === 0) {
    d.weightKg = 75;
    d.bodyFatPct = 100 * (1 - ((19.5 + 0.4 * r.g()) * 1.78 ** 2) / 75);
  }
  return d;
}
const p40: HealthspanProfile = { age: 40, sex: "male", heightCm: 178 };
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor((p / 100) * (xs.length - 1))];

describe("simulations", () => {
  it("population: median Δ +4…+8 at every age and sex, some younger, none at the clamp (version 18: +10, 0% younger)", () => {
    for (const sex of ["male", "female"] as const) {
      for (const age of [25, 40, 55, 70, 85]) {
        const r = rng(age * 7 + (sex === "male" ? 1 : 2));
        const ds: number[] = [];
        for (let k = 0; k < 250; k++) {
          const p50 = vo2maxAtPercentile(age, sex, 50);
          const iqr = vo2maxAtPercentile(age, sex, 75) - vo2maxAtPercentile(age, sex, 25);
          const v: Partial<HealthspanDay> = {
            restingHr: (sex === "male" ? 63 : 66) + 8 * r.g(),
            steps: Math.exp(Math.log(age < 60 ? 6800 : 5500) + 0.45 * r.g()),
            sleepHours: 6.8 + 0.6 * r.g(),
            sri: Math.min(95, 78 + 9 * r.g()),
            zone13Min: r.rnd() < 0.3 ? 0 : Math.exp(Math.log(60) + 0.9 * r.g()) / 7,
            zone45Min: r.rnd() < 0.5 ? 0 : Math.exp(Math.log(15) + r.g()) / 7,
            strengthMin: r.rnd() < 0.65 ? 0 : Math.exp(Math.log(60) + 0.6 * r.g()) / 7,
            vo2maxDaily: p50 + (iqr / 1.35) * r.g(),
            weightKg: null,
            bodyFatPct: null,
          };
          ds.push(run(series(180, () => v), { age, sex, heightCm: null }).deltaYears);
        }
        expect(pct(ds, 50)).toBeGreaterThan(4);
        expect(pct(ds, 50)).toBeLessThan(8);
        expect(ds.filter((d) => d < 0).length / ds.length).toBeGreaterThanOrEqual(0.03);
        expect(ds.filter((d) => Math.abs(d) >= 15)).toHaveLength(0);
      }
    }
  });

  it("a very active man is younger even at a median VO2max; a sedentary one is much older", () => {
    const habits = { restingHr: 56, steps: 10500, sleepHours: 7.3, sri: 85, zone13Min: 180 / 7, zone45Min: 60 / 7, strengthMin: 60 / 7 };
    const at = (pctl: number, h: Partial<HealthspanDay>) => run(series(180, () => ({ ...h, vo2maxDaily: vo2maxAtPercentile(40, "male", pctl) })), p40).deltaYears;
    expect(at(50, habits)).toBeLessThan(-2); // version 18: +1.3
    const couch = { restingHr: 72, steps: 3000, sleepHours: 6.6, sri: 72, zone13Min: 0, zone45Min: 0, strengthMin: 0 };
    expect(at(25, { ...couch, strengthMin: 0 })).toBeGreaterThan(8);
  });

  it("the WHOOP white paper's example people land within 3.5 years of WHOOP's published values", () => {
    // [sex, h, w, sleep, SRI ≈ Sleep Consistency + 5, steps, z13, z45, strength, VO2max, RHR, lean %, WHOOP's Δ]
    const people = [
      ["male", 176, 80, 7, 75, 8000, 100, 10, 40, 44, 60, 80, 0],
      ["female", 162, 65, 7, 75, 8000, 100, 10, 40, 38, 64, 67, 0],
      ["male", 176, 80, 7.0, 72, 10900, 141, 6, 46, 46.8, 58, 81, -1.6],
      ["female", 162, 65, 7.3, 73, 11500, 124, 7, 56, 40, 63, 73, -1.6],
      ["male", 176, 80, 6.35, 70, 5200, 69, 0, 0, 42.4, 67, 73.9, 6],
      ["female", 162, 65, 6.35, 70, 5000, 46, 0, 0, 30.2, 72, 62.2, 7.5],
    ] as const;
    for (const [sex, h, w, sl, sri, st, z13, z45, str, vo2, rhr, lbm, whoop] of people) {
      const d = run(
        series(180, (ago) => ({
          sleepHours: sl, sri, steps: st, zone13Min: z13 / 7, zone45Min: z45 / 7,
          // The US adults lift: no, but they would log it if they did; a logged 0 week keeps them measured.
          strengthMin: str ? str / 7 : ago === 170 ? 1 : 0,
          vo2maxDaily: null, vo2maxRun: vo2, restingHr: rhr, weightKg: w, bodyFatPct: 100 - lbm,
        })),
        { age: 30, sex, heightCm: h },
      ).deltaYears;
      expect(Math.abs(d - whoop)).toBeLessThan(3.5);
    }
  });

  it("first weeks: after the 14-day gate the score is within 1.5 years of where it settles (P90; version 18: 10 years)", () => {
    const gaps: number[] = [];
    for (let s = 1; s <= 60; s++) {
      const r = rng(s);
      const days = Array.from({ length: 200 }, (_, i) => noisyDay(today - 199 + i + (s % 7), active, r)).map((d, i) => ({ ...d, day: iso(today - 199 + i) }));
      const settled = healthspan(days, p40, asOf)!.deltaYears;
      let gap = 0;
      for (let t = 0; t < 40; t++) {
        const out = healthspan(days.slice(0, t + 1), p40, days[t].day);
        if (out) gap = Math.max(gap, Math.abs(out.deltaYears - settled));
        else expect(t + 1).toBeLessThan(healthspanConfig.minActivityDays);
      }
      gaps.push(gap);
    }
    expect(pct(gaps, 90)).toBeLessThan(1.5);
  });

  it("a decline shows within a month: active → sedentary adds ≥ 1.5 years in 30 days (version 18: +0.3)", () => {
    const r = rng(9);
    const days = Array.from({ length: 216 }, (_, i) => noisyDay(today - 215 + i, i < 186 ? active : sedentary, r));
    const before = healthspan(days.slice(0, 186), p40, days[185].day)!.deltaYears;
    const after = healthspan(days, p40, asOf)!;
    expect(after.deltaYears - before).toBeGreaterThanOrEqual(1.5);
    expect(after.paceOfAging).toBeGreaterThan(2);
  });

  it("stable habits: the largest daily change is under 0.06 years and Pace stays within 0.85–1.2", () => {
    for (const s of [1, 2, 3]) {
      const r = rng(s);
      const days = Array.from({ length: 366 }, (_, i) => noisyDay(today - 365 + i, active, r));
      let prev: number | null = null;
      for (let t = 200; t <= 365; t++) {
        const out = healthspan(days.slice(0, t + 1), p40, days[t].day)!;
        if (prev != null) expect(Math.abs(out.deltaYears - prev)).toBeLessThan(0.06);
        expect(out.paceOfAging).toBeGreaterThan(0.85);
        expect(out.paceOfAging).toBeLessThan(1.2);
        prev = out.deltaYears;
      }
    }
  });
});
