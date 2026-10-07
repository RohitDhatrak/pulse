import { describe, expect, it } from "vitest";
import { EFFECTS } from "../../server/sources/seed/scenario";
import { foldHistory, respCfg, restingHRCfg, sigma, zSigma } from "../scoring/baselines";
import { healthMonitor, healthMonitorConfig, type HealthMonitorDay } from "./healthMonitor";

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
    const rhr = healthMonitor(history()).vitals.find((v) => v.key === "restingHr")!;
    // RHR's floor spread is 2 bpm, so σ ≥ 2.506 and the range is at least ±6.27 around ~55.
    expect(rhr.range!.high - rhr.range!.low).toBeGreaterThanOrEqual(5 * 1.253 * 2 - 1e-9);
    expect((rhr.range!.high + rhr.range!.low) / 2).toBeCloseTo(55, 0);
  });

  it("SpO2 94 is flagged even inside the personal range, and SpO2 is never high", () => {
    const wide = history({}, 40).map((d, i) => ({ ...d, spo2: i % 2 ? 92 : 98 }));
    const r = healthMonitor([...wide, { ...wide[0], day: iso(40), spo2: 94 }]);
    const spo2 = r.vitals.find((v) => v.key === "spo2")!;
    expect(spo2.status).toBe("low");
    expect(spo2.range).toEqual({ low: 95, high: 100 });
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

  it("the seeded illness peak flags at least 2 of 5 and raises the illness signal", () => {
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
    // respiration +1.5 and HRV −15 ms now fall just inside ±1.57 and ±15.7 (at ± 2σ they flagged too: 4 of 5).
    expect(r.flagged).toBeGreaterThanOrEqual(2);
    expect(r.vitals.find((v) => v.key === "restingHr")!.status).toBe("high");
    expect(r.vitals.find((v) => v.key === "spo2")!.status).toBe("low");
    expect(r.inRange).toBeLessThanOrEqual(3);
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

  it("SpO2's low bound is max(centre − 2.5 × zSigma, 95); it is never high", () => {
    const wide = noisy().map((d, i) => ({ ...d, spo2: i % 2 ? 99.5 : 96.5 }));
    const state = foldHistory(wide.map((d) => d.spo2), healthMonitorConfig.spo2Cfg);
    const r = healthMonitor([...wide, { ...wide[0], day: iso(60), spo2: 100 }]).vitals.find((v) => v.key === "spo2")!;
    expect(r.range!.low).toBeCloseTo(Math.max(state.baseline - 2.5 * zSigma(state), 95), 12);
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
