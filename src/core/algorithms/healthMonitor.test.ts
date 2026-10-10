import { describe, expect, it } from "vitest";
import { EFFECTS } from "../../server/sources/seed/scenario";
import { foldHistory, respCfg, restingHRCfg, sigma, zSigma } from "../scoring/baselines";
import { healthMonitor, healthMonitorConfig, spo2NeedsHome, type HealthMonitorDay } from "./healthMonitor";

const iso = (i: number) => new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10);
/** Deterministic ±1 wobble. */
const wobble = (i: number) => Math.sin(i * 2.399);
/** 40 ordinary nights; `last` overrides the newest. */
const history = (last: Partial<HealthMonitorDay> = {}, n = 40): HealthMonitorDay[] =>
  Array.from({ length: n }, (_, i) => ({
    day: iso(i),
    rhr: 55 + wobble(i),
    hrv: 60 + 3 * wobble(i + 1),
    resp: 14.5 + 0.2 * wobble(i + 2),
    spo2: 97 + 0.4 * wobble(i + 3),
    skinTempDev: 0.1 * wobble(i + 4),
    ...(i === n - 1 ? last : {}),
  }));
const status = (days: HealthMonitorDay[]) => Object.fromEntries(healthMonitor(days).vitals.map((v) => [v.key, v.status]));

describe("healthMonitor", () => {
  it("an ordinary night is 5 of 5 in range with a quiet illness signal", () => {
    const r = healthMonitor(history());
    expect(r.inRange).toBe(5);
    expect(r.flagged).toBe(0);
    expect(r.illness.level).toBe("quiet");
    for (const v of r.vitals) expect(v.range!.low).toBeLessThan(v.range!.high);
  });

  it("flags a vital outside mean ± 2.5σ, high or low", () => {
    expect(status(history({ rhr: 64 }))).toMatchObject({ restingHr: "high", hrv: "in_range" });
    expect(status(history({ hrv: 35 }))).toMatchObject({ hrv: "low" });
    expect(status(history({ resp: 16.5 }))).toMatchObject({ resp: "high" });
    expect(status(history({ skinTempDev: -1.2 }))).toMatchObject({ skinTempDev: "low" });
    const r = healthMonitor(history({ rhr: 64 }));
    expect(r.inRange).toBe(4);
    expect(r.flagged).toBe(1);
  });

  it("the range is the baseline mean ± 2.5σ", () => {
    const days = history();
    const rhr = healthMonitor(days).vitals.find((v) => v.key === "restingHr")!;
    const state = foldHistory(days.slice(0, -1).map((d) => d.rhr ?? null), restingHRCfg);
    expect(rhr.range!.high - rhr.range!.low).toBeCloseTo(5 * zSigma(state), 10);
    expect((rhr.range!.high + rhr.range!.low) / 2).toBeCloseTo(state.baseline, 10);
    // Version 36: resting HR's floor spread is 1 bpm (was 2), so σ ≥ 1.253 and the range at least ±3.13.
    expect(rhr.range!.high - rhr.range!.low).toBeGreaterThanOrEqual(5 * 1.253 * 1 - 1e-9);
    expect((rhr.range!.high + rhr.range!.low) / 2).toBeCloseTo(55, 0);
  });

  it("SpO2 is judged against your own normal: 2 points below it is low, however variable your nights; never high", () => {
    // Nights alternate 92 and 98: a normal of 95 with a wide range. Version 21 floored the low bound at 95, so 94 was
    // low; version 22 caps the drop at 2 points: low below 93.
    const wide = history({}, 40).map((d, i) => ({ ...d, spo2: i % 2 ? 92 : 98 }));
    const at = (v: number) => healthMonitor([...wide, { ...wide[0], day: iso(40), spo2: v }]).vitals.find((x) => x.key === "spo2")!;
    const state = foldHistory(wide.map((d) => d.spo2), healthMonitorConfig.spo2Cfg);
    expect(at(94).status).toBe("in_range");
    expect(at(94).range!.low).toBeCloseTo(state.baseline - 2, 10);
    expect(at(94).usual).toBeCloseTo(state.baseline, 10);
    expect(at(state.baseline - 2.05).status).toBe("low");
    expect(status(history({ spo2: 100 })).spo2).toBe("in_range");
  });

  it("a range from Google replaces the baseline's, even before the baseline is usable", () => {
    const r = healthMonitor(history({ rhr: 59 }, 3), {}, { restingHr: { low: 50, high: 58 } });
    const rhr = r.vitals.find((v) => v.key === "restingHr")!;
    expect(rhr).toMatchObject({ range: { low: 50, high: 58 }, rangeSource: "google", status: "high" });
    expect(r.vitals.find((v) => v.key === "hrv")).toMatchObject({ range: null, status: "no_data" });
    expect(healthMonitor(history()).vitals.every((v) => v.rangeSource === "pulse")).toBe(true);
  });

  it("missing values and unusable baselines are no_data, not in range", () => {
    expect(status(history({ spo2: null })).spo2).toBe("no_data");
    const short = history({}, 3);
    expect(healthMonitor(short).vitals.every((v) => v.status === "no_data" && v.range == null)).toBe(true);
    expect(healthMonitor([]).inRange).toBe(0);
  });

  it("the seeded illness peak flags at least 3 of 5 and raises the illness signal", () => {
    const ill = EFFECTS.illness;
    const base = history();
    const peak = base.at(-1)!;
    const r = healthMonitor([
      ...base.slice(0, -1),
      {
        ...peak,
        rhr: 55 + ill.rhr,
        hrv: 60 * (1 + ill.hrv),
        resp: 14.5 + ill.resp,
        spo2: 97 + ill.spo2,
        skinTempDev: ill.tempC,
      },
    ]);
    // Version 16 (± 2.5σ): resting HR and SpO2 flag. On this very smooth history the floor spreads set the ranges, and
    // respiration +1.5 falls just inside ±1.57 (at ± 2σ it flagged too). Version 36: HRV −15 ms (−25 %) flags as well,
    // against 49.7–70.2 ms (the floor at 60 ms is 3 ms; the fixed 5 ms floor gave ±15.7).
    expect(r.flagged).toBeGreaterThanOrEqual(3);
    expect(r.vitals.find((v) => v.key === "restingHr")!.status).toBe("high");
    expect(r.vitals.find((v) => v.key === "spo2")!.status).toBe("low");
    expect(r.vitals.find((v) => v.key === "hrv")!.status).toBe("low");
    expect(r.inRange).toBeLessThanOrEqual(2);
    expect(r.illness.level).toBe("raised");
    expect(r.illness.baselineTrusted).toBe(true);
  });
});

describe("healthMonitor: short-history shrink on the personal range", () => {
  const rhrRange = (days: HealthMonitorDay[]) => healthMonitor(days).vitals.find((v) => v.key === "restingHr")!.range!;

  it("the range is the baseline ± rangeSigmas × zSigma of the fold over the prior nights", () => {
    const k = healthMonitorConfig.rangeSigmas;
    for (const n of [8, 15, 41]) {
      const days = history({}, n);
      const state = foldHistory(days.slice(0, -1).map((d) => d.rhr ?? null), restingHRCfg);
      const r = rhrRange(days);
      expect(r.low).toBeCloseTo(state.baseline - k * zSigma(state), 12);
      expect(r.high).toBeCloseTo(state.baseline + k * zSigma(state), 12);
      // Wider than the raw ± kσ by exactly (n + 2) / n.
      expect((r.high - r.low) / (2 * k * sigma(state))).toBeCloseTo((state.nValid + 2) / state.nValid, 12);
    }
  });

  it("a reading just inside raw 2σ but outside the widened range is not flagged early on", () => {
    const days = history({}, 8);
    const state = foldHistory(days.slice(0, -1).map((d) => d.rhr ?? null), restingHRCfg);
    const between = state.baseline + 2.1 * sigma(state); // inside 2.5 × (9/7)σ
    expect(status(history({ rhr: between }, 8)).restingHr).toBe("in_range");
  });
});

describe("healthMonitor: Pulse's ranges at ± 2.5σ (SCORING_VERSION 16)", () => {
  /** A 60-night history with real noise (deterministic), RHR around 55 and the other vitals steady. */
  const noisy = (n = 60) => {
    let x = 5;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648), x / 2147483648);
    const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
    return Array.from({ length: n }, (_, i) => ({ day: iso(i), rhr: 55 + 4 * g(), hrv: 60, resp: 14.5, spo2: 97, skinTempDev: 0 }));
  };
  const rhrAt = (days: HealthMonitorDay[], zOffset: number) => {
    const state = foldHistory(days.map((d) => d.rhr ?? null), restingHRCfg);
    return { state, value: state.baseline + zOffset * zSigma(state) };
  };

  it("rangeSigmas is 2.5", () => {
    expect(healthMonitorConfig.rangeSigmas).toBe(2.5);
  });

  it("on a long history, +2.2σ is in range and +2.6σ is flagged, both ways", () => {
    const days = noisy();
    for (const [z, want] of [[2.2, "in_range"], [2.6, "high"], [-2.2, "in_range"], [-2.6, "low"]] as const) {
      const { value } = rhrAt(days, z);
      expect(status([...days, { ...days[0], day: iso(60), rhr: value }]).restingHr, `z ${z}`).toBe(want);
    }
  });

  it("SpO2's low bound is max(92, centre − min(2.5 × zSigma, 2)); it is never high", () => {
    const wide = noisy().map((d, i) => ({ ...d, spo2: i % 2 ? 99.5 : 96.5 }));
    const state = foldHistory(wide.map((d) => d.spo2), healthMonitorConfig.spo2Cfg);
    const r = healthMonitor([...wide, { ...wide[0], day: iso(60), spo2: 100 }]).vitals.find((v) => v.key === "spo2")!;
    expect(r.range!.low).toBeCloseTo(Math.max(92, state.baseline - Math.min(2.5 * zSigma(state), 2)), 12);
    expect(r.range!.high).toBe(100);
    expect(r.status).toBe("in_range");
  });

  it("Google's range is used exactly as given, even when narrower than Pulse's ± 2.5σ", () => {
    const days = noisy();
    const given = { low: 54, high: 56 };
    const r = healthMonitor([...days, { ...days[0], day: iso(60), rhr: 57 }], {}, { restingHr: given });
    expect(r.vitals.find((v) => v.key === "restingHr")).toMatchObject({ range: given, rangeSource: "google", status: "high" });
  });

  it("respiration uses the same ± 2.5 × zSigma (its floor gives at least ± 1.57)", () => {
    const r = healthMonitor(history()).vitals.find((v) => v.key === "resp")!;
    expect((r.range!.high - r.range!.low) / 2).toBeGreaterThanOrEqual(2.5 * 1.253 * respCfg.floorSpread - 1e-9);
  });

  it("simulated healthy nights: about 3 % flagged at ± 2.5σ against about 10 % at ± 2σ; full illness always flags", () => {
    let x = 77;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648), x / 2147483648);
    const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
    const ill = EFFECTS.illness;
    const rate = (k: number) => {
      const saved = healthMonitorConfig.rangeSigmas;
      healthMonitorConfig.rangeSigmas = k;
      let nights = 0;
      let flagged = 0;
      let sickAny = 0;
      let sickTwo = 0;
      for (let p = 0; p < 60; p++) {
        const person = { rhr: 52 + 10 * rnd(), hrv: 35 + 40 * rnd(), resp: 13.5 + 2 * rnd() };
        const draw = (i: number): HealthMonitorDay => ({
          day: iso(i), rhr: person.rhr + 2.5 * g(), hrv: person.hrv * Math.exp(0.15 * g()), resp: person.resp + 0.5 * g(),
          spo2: Math.min(100, 96.5 + 0.6 * g()), skinTempDev: 0.25 * g(),
        });
        const days = Array.from({ length: 60 }, (_, i) => draw(i));
        for (let n = 0; n < 15; n++) {
          nights++;
          if (healthMonitor([...days, draw(60 + n)]).flagged > 0) flagged++;
        }
        const h = draw(60);
        const sick = { ...h, rhr: h.rhr! + ill.rhr, hrv: h.hrv! * (1 + ill.hrv), resp: h.resp! + ill.resp, spo2: h.spo2! + ill.spo2, skinTempDev: h.skinTempDev! + ill.tempC };
        const f = healthMonitor([...days, sick]).flagged;
        if (f >= 1) sickAny++;
        if (f >= 2) sickTwo++;
      }
      healthMonitorConfig.rangeSigmas = saved;
      return { falseRate: flagged / nights, sickAny: sickAny / 60, sickTwo: sickTwo / 60 };
    };
    const now = rate(2.5);
    const before = rate(2);
    expect(now.falseRate).toBeLessThanOrEqual(0.05);
    expect(before.falseRate).toBeGreaterThan(0.07);
    expect(now.sickAny).toBe(1);
    expect(now.sickTwo).toBeGreaterThanOrEqual(0.75);
  });
});

// ── SpO2 against your own normal (SCORING_VERSION 22; docs/algorithms/health-monitor.md § Why version 22) ─────────
describe("SpO2's low bound", () => {
  /** n steady nights at `mu` with a ±`sd` wobble; other vitals ordinary. */
  const steady = (mu: number, sd: number, n = 40) => history({}, n).map((d, i) => ({ ...d, spo2: mu + sd * wobble(i + 3) }));
  const spo2At = (days: HealthMonitorDay[], v: number) =>
    healthMonitor([...days, { ...days[0], day: iso(days.length), spo2: v }]).vitals.find((x) => x.key === "spo2")!;

  it("a steady normal of 95.5: low = 95.5 − min(2.5σ, 2), hand-computed from the baseline", () => {
    const days = steady(95.5, 0.3);
    const state = foldHistory(days.map((d) => d.spo2), healthMonitorConfig.spo2Cfg);
    const low = state.baseline - Math.min(2.5 * zSigma(state), 2);
    expect(spo2At(days, 95).range!.low).toBeCloseTo(low, 12);
    // 95 sat inside the old 95 % floor's "low"; now it is ordinary.
    expect(spo2At(days, 94.9).status).toBe(94.9 < low ? "low" : "in_range");
    expect(spo2At(days, 93.4).status).toBe("low");
  });

  it("a normal of 93: the 92 % safety floor binds", () => {
    const days = steady(93, 0.3);
    expect(spo2At(days, 92.1).status).toBe("in_range");
    expect(spo2At(days, 91.9)).toMatchObject({ status: "low", range: { low: 92, high: 100 } });
  });

  it("below 92 % is low from the first night, before any baseline", () => {
    const one = history({}, 1).map((d) => ({ ...d, spo2: 91 }));
    expect(healthMonitor(one).vitals.find((v) => v.key === "spo2")).toMatchObject({ status: "low", range: { low: 92, high: 100 } });
    const fine = history({}, 1).map((d) => ({ ...d, spo2: 96 }));
    expect(healthMonitor(fine).vitals.find((v) => v.key === "spo2")!.status).toBe("no_data");
  });

  it("spo2NeedsHome: only below 92 or 3+ points below your normal", () => {
    const days = steady(96, 0.3);
    expect(spo2NeedsHome(spo2At(days, 93.5))).toBe(false); // low on the Monitor (2.5 below), not on Home
    expect(spo2At(days, 93.5).status).toBe("low");
    expect(spo2NeedsHome(spo2At(days, 92.9))).toBe(true); // 3+ below
    expect(spo2NeedsHome(spo2At(steady(93, 0.3), 91.5))).toBe(true); // below the floor
    expect(spo2NeedsHome(spo2At(days, 96))).toBe(false);
  });
});

describe("SpO2 on simulated people (version 22)", () => {
  let x = 3;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648), x / 2147483648);
  const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
  const r1 = (v: number) => Math.min(100, Math.round(v * 10) / 10);
  const night = (i: number, spo2: number): HealthMonitorDay => ({ day: iso(i), rhr: 55 + wobble(i), hrv: 60 + 3 * wobble(i + 1), resp: 14.5, skinTempDev: 0, spo2 });
  /** Share of scored nights from `from` on flagged low, over 30 people. */
  const share = (make: (i: number) => number, n: number, from: number, only?: (v: number) => boolean) => {
    let hit = 0, tot = 0;
    for (let p = 0; p < 30; p++) {
      const days = Array.from({ length: n }, (_, i) => night(i, r1(make(i))));
      for (let t = from; t < n; t++) {
        if (only && !only(days[t].spo2!)) continue;
        const v = healthMonitor(days.slice(0, t + 1)).vitals.find((r) => r.key === "spo2")!;
        tot++;
        if (v.status === "low") hit++;
      }
    }
    return hit / tot;
  };

  it("ordinary nights: few false flags at any normal (version 21: 88 % at a normal of 94, 46 % at 95)", () => {
    x = 3;
    expect(share(() => 93 + 0.8 * g(), 90, 60)).toBeLessThanOrEqual(0.1);
    for (const mu of [94, 95, 96, 97, 98]) {
      x = 3;
      expect(share(() => mu + 0.8 * g(), 90, 60)).toBeLessThanOrEqual(0.03);
    }
  });

  it("a real drop is caught: −3 on at least 75 % of nights and −2 on at least 35 %, at normals of 94, 95.5 and 97", () => {
    for (const mu of [94, 95.5, 97]) {
      x = 5;
      expect(share((i) => mu + 0.8 * g() - (i >= 65 ? 3 : 0), 70, 65)).toBeGreaterThanOrEqual(0.75);
      x = 5;
      expect(share((i) => mu + 0.8 * g() - (i >= 65 ? 2 : 0), 70, 65)).toBeGreaterThanOrEqual(0.35);
    }
  });

  it("a slow decline the baseline would follow (96 → 90 over 6 weeks): nights below 92 are flagged (at least 95 %)", () => {
    x = 7;
    expect(share((i) => 96 - (i >= 60 ? (6 * (i - 60)) / 42 : 0) + 0.6 * g(), 102, 60, (v) => v < 92)).toBeGreaterThanOrEqual(0.95);
  });

  it("a constant 91 % (low at sea level) is flagged on most nights", () => {
    x = 9;
    expect(share(() => 91 + 0.8 * g(), 90, 60)).toBeGreaterThanOrEqual(0.85);
  });
});
