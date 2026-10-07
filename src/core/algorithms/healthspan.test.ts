import { describe, expect, it } from "vitest";
import { isoEpochDay } from "../scoring/baselines";
import { piecewiseLinear, vo2maxAtPercentile } from "./fitnessLevel";
import {
  curves,
  healthspan,
  healthspanConfig,
  referenceProfile,
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
/** ln HR → years: the 0.75 shrink ÷ (ln 2 / 8). (Since version 14 nothing is scaled up for missing terms.) */
const years = (lnHr: number) => (lnHr * 0.75) / (Math.LN2 / 8);

/** A day exactly at the reference profile: FFMI 18.9 at 1.80 m and 20 % body fat. */
const refDay = (): Omit<HealthspanDay, "day"> => ({
  sleepHours: ref.sleepHours,
  sri: ref.sri,
  zone13Min: ref.zone13 / 7,
  zone45Min: ref.zone45 / 7,
  strengthMin: ref.strength / 7,
  steps: ref.steps,
  vo2maxRun: ref.vo2max,
  restingHr: ref.restingHr,
  weightKg: (ref.leanMass * 1.8 ** 2) / 0.8,
  bodyFatPct: 20,
});
/** `n` days ending today; `f(age)` overrides fields, where `age` is days before today. */
const series = (n: number, f: (daysAgo: number) => Partial<HealthspanDay> = () => ({})): HealthspanDay[] =>
  Array.from({ length: n }, (_, i) => ({ day: iso(today - (n - 1 - i)), ...refDay(), ...f(n - 1 - i) }));
const run = (days: HealthspanDay[], p: HealthspanProfile = profile) => healthspan(days, p, asOf)!;

describe("Pulse Age", () => {
  it("the reference profile scores Pulse Age = chronological age", () => {
    const r = run(series(180));
    expect(r.pulseAge).toBeCloseTo(35, 10);
    expect(r.contributions).toHaveLength(9);
    for (const c of r.contributions) expect(c.years).toBeCloseTo(0, 10);
    expect(r.paceOfAging).toBeCloseTo(1, 10);
  });

  it("higher VO2max lowers it: +2 METs is 2 · ln 0.87 of hazard", () => {
    const r = run(series(180, () => ({ vo2maxRun: ref.vo2max + 7 })));
    expect(r.deltaYears).toBeCloseTo(years(2 * Math.log(0.87)), 10);
    expect(r.deltaYears).toBeCloseTo(-2.41, 2);
  });

  it("higher resting HR raises it: +10 bpm is ln 1.09", () => {
    const r = run(series(180, () => ({ restingHr: 70 })));
    expect(r.deltaYears).toBeCloseTo(years(Math.log(1.09)), 10);
    expect(r.deltaYears).toBeCloseTo(0.75, 2);
  });

  it("missing lean mass counts as typical (Schutz median = the reference: 0 years); nothing is scaled up", () => {
    const r = run(series(180, () => ({ restingHr: 70 })), { ...profile, heightCm: null });
    const lean = r.contributions.find((c) => c.key === "leanMass")!;
    expect(lean).toMatchObject({ estimated: true, value: ref.leanMass, years: 0 });
    expect(r.contributions).toHaveLength(9);
    // Version 13 scaled the other eight by 9/8: +0.84 years instead of +0.75.
    expect(r.deltaYears).toBeCloseTo(years(Math.log(1.09)), 10);
    // Body fat without weight on any day drops it too.
    const r2 = run(series(180, () => ({ restingHr: 70, weightKg: null })));
    expect(r2.deltaYears).toBeCloseTo(r.deltaYears, 10);
  });

  it("contributions sum to the unclamped Δage", () => {
    const r = run(series(180, () => ({ restingHr: 66, steps: 6000, sleepHours: 6, sri: 70 })));
    expect(r.contributions.reduce((a, c) => a + c.years, 0)).toBeCloseTo(r.deltaYears, 10);
    expect(r.contributions.find((c) => c.key === "steps")!.years).toBeGreaterThan(0);
  });

  it("clamps to ±15 years", () => {
    const bad = run(
      series(180, () => ({ vo2maxRun: 15, restingHr: 100, steps: 2000, sleepHours: 4, sri: 40, zone13Min: 0, zone45Min: 0, strengthMin: 0 })),
    );
    expect(bad.pulseAge).toBe(50);
    expect(bad.deltaYears).toBe(15);
    const old: HealthspanProfile = { age: 75, sex: "male", heightCm: 180 };
    const good = run(series(180, () => ({ vo2maxRun: 80, restingHr: 45, zone13Min: 60, zone45Min: 60, sri: 95, weightKg: 90 })), old);
    expect(good.pulseAge).toBe(60);
  });

  it("is provisional below 20 days of data", () => {
    expect(run(series(19)).provisional).toBe(true);
    const r = run(series(20));
    expect(r.provisional).toBe(false);
    expect(r.dataDays).toBe(20);
    // Empty rows are not data.
    const padded = [...series(19), ...Array.from({ length: 5 }, (_, i) => ({ day: iso(today - 30 - i) }))];
    expect(run(padded).provisional).toBe(true);
  });

  it("is null below minTerms inputs or for a bad date", () => {
    expect(healthspan([{ day: asOf, restingHr: 60, steps: 9000 }], profile, asOf)).toBeNull();
    expect(healthspan(series(30), profile, "not-a-day")).toBeNull();
  });

  it("ignores days after asOf and before the 6-month window", () => {
    const later = { day: iso(today + 1), ...refDay(), restingHr: 120 };
    const older = { day: iso(today - 200), ...refDay(), restingHr: 120 };
    expect(run([older, ...series(180), later]).deltaYears).toBeCloseTo(0, 10);
  });
});

describe("VO2max source rule", () => {
  const plus7 = ref.vo2max + 7;
  const full = years(2 * Math.log(0.87));

  it("a run-vo2-max value in the last 90 days is used at full weight", () => {
    const r = run(series(180, (ago) => ({ vo2maxRun: ago === 80 ? plus7 : null, vo2maxDaily: ref.vo2max })));
    expect(r.vo2maxSource).toBe("run");
    expect(r.contributions.find((c) => c.key === "vo2max")!.years).toBeCloseTo(full, 10);
  });

  it("with only daily-vo2-max, the same value moves Pulse Age half as much", () => {
    const r = run(series(180, () => ({ vo2maxRun: null, vo2maxDaily: plus7 })));
    expect(r.vo2maxSource).toBe("daily");
    expect(r.deltaYears).toBeCloseTo(full / 2, 10);
  });

  it("a run value older than 90 days falls back to daily", () => {
    const r = run(series(180, (ago) => ({ vo2maxRun: ago === 100 ? plus7 : null, vo2maxDaily: ref.vo2max })));
    expect(r.vo2maxSource).toBe("daily");
    expect(r.deltaYears).toBeCloseTo(0, 10);
  });

  it("no VO2max at all counts as the FRIEND 50th percentile, at full weight (it stands in for the true value)", () => {
    const r = run(series(180, () => ({ vo2maxRun: null })));
    expect(r.vo2maxSource).toBeNull();
    const v = r.contributions.find((c) => c.key === "vo2max")!;
    expect(v.estimated).toBe(true);
    expect(v.value).toBeCloseTo(vo2maxAtPercentile(35, "male", 50), 10);
    const ln = piecewiseLinear(curves.vo2max, v.value) - piecewiseLinear(curves.vo2max, ref.vo2max);
    expect(v.years).toBeCloseTo(years(ln), 10);
    expect(r.deltaYears).toBeCloseTo(v.years, 10);
  });
});

describe("Pace of Aging", () => {
  it("flat inputs give 1.0", () => {
    expect(run(series(180, () => ({ restingHr: 68, steps: 7000 }))).paceOfAging).toBeCloseTo(1, 10);
  });

  it("an input missing in the last 30 days keeps its 6-month value, so flat stays 1.0", () => {
    const r = run(series(180, (ago) => (ago < 30 ? { weightKg: null, bodyFatPct: null } : {})));
    expect(r.contributions).toHaveLength(9);
    expect(r.paceOfAging).toBeCloseTo(1, 10);
  });

  it("improving the last 30 days gives < 1, worsening gives > 1", () => {
    const better = run(series(180, (ago) => ({ restingHr: ago < 30 ? 50 : 60 })));
    // 6-month mean 58.33 bpm vs 30-day 50 bpm.
    expect(better.paceOfAging).toBeCloseTo(1 + (years(-Math.log(1.09)) - years((-10 / 60) * Math.log(1.09))) / 5, 10);
    expect(better.paceOfAging).toBeLessThan(1);
    expect(run(series(180, (ago) => ({ restingHr: ago < 30 ? 75 : 60 }))).paceOfAging).toBeGreaterThan(1);
  });

  it("stays within [−1, 3]", () => {
    const awful = { vo2maxRun: 15, restingHr: 100, steps: 2000, sleepHours: 4, sri: 40, zone13Min: 0, zone45Min: 0, strengthMin: 0 };
    const great = { vo2maxRun: 70, restingHr: 45, zone13Min: 60, zone45Min: 60, sri: 95 };
    expect(run(series(180, (ago) => (ago < 30 ? great : awful))).paceOfAging).toBe(-1);
    expect(run(series(180, (ago) => (ago < 30 ? awful : great))).paceOfAging).toBe(3);
    for (let rhr = 40; rhr <= 110; rhr += 5) {
      const p = run(series(180, (ago) => ({ restingHr: ago < 30 ? rhr : 110 - rhr + 40 }))).paceOfAging;
      expect(p).toBeGreaterThanOrEqual(-1);
      expect(p).toBeLessThanOrEqual(3);
    }
  });

  it("is provisional until the data spans 6 months", () => {
    expect(run(series(179)).paceProvisional).toBe(true);
    expect(run(series(180)).paceProvisional).toBe(false);
  });
});

describe("dose-response curves", () => {
  /** Sign of each successive step over a sweep wider than the knots. */
  const steps = (key: HealthspanInput, from: number, to: number) => {
    const xs = Array.from({ length: 401 }, (_, i) => from + ((to - from) * i) / 400);
    return xs.slice(1).map((x, i) => ({ x, d: piecewiseLinear(curves[key], x) - piecewiseLinear(curves[key], xs[i]) }));
  };
  const span = (key: HealthspanInput) => {
    const k = curves[key];
    const lo = k[0][0];
    const hi = k[k.length - 1][0];
    return [lo - (hi - lo) * 0.2, hi + (hi - lo) * 0.2] as const;
  };

  it.each(["vo2max", "steps", "sri", "zone13", "zone45", "leanMass"] as const)("%s never raises hazard as it rises", (key) => {
    const s = steps(key, ...span(key));
    for (const { d } of s) expect(d).toBeLessThanOrEqual(1e-12);
    expect(s.some(({ d }) => d < 0)).toBe(true);
  });

  it("restingHr never lowers hazard as it rises", () => {
    const s = steps("restingHr", ...span("restingHr"));
    for (const { d } of s) expect(d).toBeGreaterThanOrEqual(-1e-12);
  });

  it("sleepHours is U-shaped: falls to 7 h, flat to 8 h, rises after", () => {
    for (const { x, d } of steps("sleepHours", 3, 11)) {
      if (x <= 7) expect(d).toBeLessThanOrEqual(1e-12);
      else if (x <= 8) expect(d).toBeCloseTo(0, 12);
      else expect(d).toBeGreaterThanOrEqual(-1e-12);
    }
  });

  it("strength is J-shaped: falls to the 40 min/week nadir, rises back to RR 1 at 140", () => {
    for (const { x, d } of steps("strength", 0, 200)) {
      if (x <= 40) expect(d).toBeLessThanOrEqual(1e-12);
      else expect(d).toBeGreaterThanOrEqual(-1e-12);
    }
    expect(piecewiseLinear(curves.strength, 140)).toBeCloseTo(0, 12);
  });

  it("is flat beyond the end knots", () => {
    for (const key of Object.keys(curves) as HealthspanInput[]) {
      const k = curves[key];
      expect(piecewiseLinear(k, k[0][0] - 100)).toBe(k[0][1]);
      expect(piecewiseLinear(k, k[k.length - 1][0] + 1e6)).toBe(k[k.length - 1][1]);
    }
  });

  it("steps beyond the age plateau earn nothing", () => {
    expect(run(series(180, () => ({ steps: 15_000 }))).deltaYears).toBeCloseTo(0, 10);
    expect(referenceProfile(65, "female").steps).toBe(healthspanConfig.stepsPlateau.from60);
  });
});

describe("missing inputs count as a typical person (SCORING_VERSION 14)", () => {
  it("typical profile: FRIEND 50th VO2max, 65 bpm, 6,800 steps, 7 h, SRI 81, and the reference elsewhere", () => {
    for (const [age, sex] of [[35, "male"], [52, "female"], [71, "male"]] as const) {
      const t = typicalProfile(age, sex);
      const r = referenceProfile(age, sex);
      expect(t.vo2max).toBeCloseTo(vo2maxAtPercentile(age, sex, 50), 10);
      expect(t.vo2max).toBeLessThan(r.vo2max);
      expect([t.restingHr, t.steps, t.sleepHours, t.sri]).toEqual([65, 6800, 7, 81]);
      expect([t.zone13, t.zone45, t.strength, t.leanMass]).toEqual([r.zone13, r.zone45, r.strength, r.leanMass]);
    }
    // Interpolated between decade midpoints, like the reference: no jump on a birthday.
    expect(Math.abs(typicalProfile(39.99, "male").vo2max - typicalProfile(40.01, "male").vo2max)).toBeLessThan(0.01);
  });

  it("each missing input adds exactly its typical value's years, and is marked estimated", () => {
    const t = typicalProfile(35, "male");
    const r = run(series(180, () => ({ sri: null, sleepHours: null, vo2maxRun: null })), { ...profile, heightCm: null });
    const est = r.contributions.filter((c) => c.estimated).map((c) => c.key).sort();
    expect(est).toEqual(["leanMass", "sleepHours", "sri", "vo2max"]);
    const sri = r.contributions.find((c) => c.key === "sri")!;
    expect(sri.value).toBe(81);
    expect(sri.years).toBeCloseTo(years(piecewiseLinear(curves.sri, 81) - piecewiseLinear(curves.sri, ref.sri)), 10);
    expect(r.contributions.find((c) => c.key === "sleepHours")!.years).toBeCloseTo(0, 10); // 7 h is in Cappuccio's band
    const vo2 = years(piecewiseLinear(curves.vo2max, t.vo2max) - piecewiseLinear(curves.vo2max, ref.vo2max));
    expect(r.deltaYears).toBeCloseTo(sri.years + vo2, 10);
  });

  it(`still needs ${healthspanConfig.minTerms} measured inputs`, () => {
    // No height drops lean mass too, so four more missing leaves 4 measured; three more leaves 5.
    const four = series(180, () => ({ sri: null, sleepHours: null, vo2maxRun: null, steps: null }));
    expect(healthspan(four, { ...profile, heightCm: null }, asOf)).toBeNull();
    const five = series(180, () => ({ sri: null, sleepHours: null, vo2maxRun: null }));
    expect(healthspan(five, { ...profile, heightCm: null }, asOf)).not.toBeNull();
  });

  it("the doc's example 4 (a typical week): +3.77 with height, +4.48 without (version 13: +4.16 and +5.48)", () => {
    // VO2max 44 (run), RHR 62, 8,500 steps, 6.8 h, SRI 78, 120 / 30 / 60 min a week, 80 kg at 18 % fat.
    const week = (): Partial<HealthspanDay> => ({
      vo2maxRun: 44, restingHr: 62, steps: 8500, sleepHours: 6.8, sri: 78,
      zone13Min: 120 / 7, zone45Min: 30 / 7, strengthMin: 60 / 7, weightKg: 80, bodyFatPct: 18,
    });
    const r = run(series(180, week));
    const byKey = Object.fromEntries(r.contributions.map((c) => [c.key, c.years]));
    // Steps (+0.67) and zones 1–3 (+0.39) both penalise the same activity: only steps counts now.
    expect(byKey.steps).toBeCloseTo(0.67, 2);
    expect(byKey.zone13).toBe(0);
    expect(r.contributions.find((c) => c.key === "zone13")!.overlapped).toBe(true);
    expect(r.deltaYears).toBeCloseTo(3.77, 2);
    // Without height lean mass (−0.72) counts as typical (0): +4.48, not 9/8 × the rest = +5.48.
    expect(run(series(180, week), { ...profile, heightCm: null }).deltaYears).toBeCloseTo(4.48, 2);
  });
});

describe("steps and zones 1–3 count once (SCORING_VERSION 14)", () => {
  const toY = (key: HealthspanInput, x: number) => years(piecewiseLinear(curves[key], x) - piecewiseLinear(curves[key], ref[key]));

  it("an inactive person (3,000 steps, no zone time) gets the larger penalty only: +7.9, not +14.1", () => {
    const r = run(series(180, () => ({ steps: 3000, zone13Min: 0 })));
    const steps = r.contributions.find((c) => c.key === "steps")!;
    const zones = r.contributions.find((c) => c.key === "zone13")!;
    expect(zones.years).toBeCloseTo(toY("zone13", 0), 10);
    expect(zones.years).toBeCloseTo(7.93, 2);
    expect(steps).toMatchObject({ years: 0, overlapped: true });
    expect(r.deltaYears).toBeCloseTo(7.93, 2);
    expect(toY("steps", 3000) + toY("zone13", 0)).toBeCloseTo(14.06, 1); // version 13
  });

  it("when steps is the larger penalty, zones is the one dropped", () => {
    // 100 min/week is a small zones penalty; 3,000 steps a large one.
    const r = run(series(180, () => ({ steps: 3000, zone13Min: 100 / 7 })));
    expect(toY("zone13", 100)).toBeGreaterThan(0);
    expect(r.contributions.find((c) => c.key === "steps")!.years).toBeCloseTo(toY("steps", 3000), 10);
    expect(r.contributions.find((c) => c.key === "zone13")).toMatchObject({ years: 0, overlapped: true });
  });

  it("a bonus is never dropped: only two penalties overlap", () => {
    const r = run(series(180, () => ({ steps: 3000, zone13Min: 200 / 7 })));
    expect(r.contributions.find((c) => c.key === "zone13")!.years).toBeLessThan(0);
    expect(r.contributions.find((c) => c.key === "steps")!.years).toBeCloseTo(toY("steps", 3000), 10);
    expect(r.contributions.some((c) => c.overlapped)).toBe(false);
  });

  it("other terms are untouched by the rule", () => {
    const r = run(series(180, () => ({ steps: 3000, zone13Min: 0, restingHr: 70 })));
    expect(r.contributions.find((c) => c.key === "restingHr")!.years).toBeCloseTo(years(Math.log(1.09)), 10);
  });
});

describe("population check: a missing lean mass (no smart scale)", () => {
  it("errs by at most 1.2 years on average and is nearly unbiased (version 13: about +1.3 ± 1.5)", () => {
    let x = 9;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648), x / 2147483648);
    const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
    const errs: number[] = [];
    for (let i = 0; i < 300; i++) {
      const p = {
        vo2maxRun: 40 + 7 * g(), restingHr: 62 + 7 * g(), steps: Math.max(1500, 7500 + 2800 * g()), sleepHours: 6.9 + 0.7 * g(),
        sri: 78 + 8 * g(), zone13Min: Math.max(0, 120 + 90 * g()) / 7, zone45Min: Math.max(0, 25 + 40 * g()) / 7,
        strengthMin: rnd() < 0.6 ? 0 : Math.max(0, 60 + 30 * g()) / 7, weightKg: 82 + 12 * g(), bodyFatPct: Math.min(40, Math.max(8, 22 + 6 * g())),
      };
      const full = healthspan(series(180, () => p), { age: 40, sex: "male", heightCm: 180 }, asOf)!;
      const noScale = healthspan(series(180, () => p), { age: 40, sex: "male", heightCm: null }, asOf)!;
      const raw = (r: typeof full) => r.contributions.reduce((a, c) => a + c.years, 0); // unclamped
      errs.push(raw(noScale) - raw(full));
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(Math.abs(mean(errs))).toBeLessThanOrEqual(0.5);
    expect(mean(errs.map(Math.abs))).toBeLessThanOrEqual(1.2);
  });
});
