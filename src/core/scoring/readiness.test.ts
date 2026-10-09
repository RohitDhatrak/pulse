import { describe, expect, it } from "vitest";
import { foldHistory, restingHRCfg, sigma } from "./baselines";
import { acwrBand, acwrChronicFloor, acwrSignal, evaluate, evaluateWithTrainingLoad, lightLoadJump, mean, minAcute, minChronic, type ReadinessDay, sampleSD } from "./readiness";
import { trimpToStrain } from "./strain";

const pad = (n: number) => String(n).padStart(2, "0");
const d = (i: number, hrv: number | null, rhr: number | null, load: number | null, resp: number | null = null): ReadinessDay => ({
  day: `2024-03-${pad(i)}`,
  hrv,
  rhr,
  load,
  resp,
});

/**
 * 28 baseline days with gentle variation, then today as day 29. Loads are 10× noop's (100, not 10) since version 27:
 * a chronic load under 30 TRIMP a day is a light load with no ratio, and these cases test the ratio.
 */
function baseline(todayHrv: number | null, todayRhr: number | null, todayLoad: number | null, todayResp: number | null = null) {
  const days: ReadinessDay[] = [];
  for (let i = 1; i <= 28; i++) days.push(d(i, i % 2 === 0 ? 62 : 58, i % 2 === 0 ? 54 : 50, 100, i % 2 === 0 ? 14.5 : 13.5));
  days.push(d(29, todayHrv, todayRhr, todayLoad, todayResp));
  return days;
}

const flagOf = (r: ReturnType<typeof evaluate>, key: string) => r.signals.find((s) => s.key === key)?.flag;

describe("ReadinessEngineTest", () => {
  it("insufficient when empty", () => {
    expect(evaluate([]).level).toBe("insufficient");
  });

  it("primed when signals aligned", () => {
    const r = evaluate(baseline(72, 46, 100));
    expect(r.level).toBe("primed");
    expect(flagOf(r, "hrv")).toBe("good");
    expect(flagOf(r, "rhr")).toBe("good");
    expect(flagOf(r, "acwr")).toBe("good");
  });

  it("rundown when two recovery signals down", () => {
    expect(evaluate(baseline(50, 60, 100)).level).toBe("rundown");
  });

  it("ACWR spike strains", () => {
    const days: ReadinessDay[] = [];
    // 10× noop's loads (5 and 15), so the chronic load is over the version 27 floor and the ratio applies.
    for (let i = 1; i <= 21; i++) days.push(d(i, 60, 52, 50));
    for (let i = 22; i <= 28; i++) days.push(d(i, 60, 52, 150));
    days.push(d(29, 60, 52, 150));
    const r = evaluate(days);
    expect(flagOf(r, "acwr")).toBe("bad");
    expect(r.level).toBe("strained");
    expect(r.acwr!).toBeGreaterThan(1.5);
  });

  it("resp rate rise flags", () => {
    expect(evaluate(baseline(60, 52, 100, 18)).signals.some((s) => s.key === "respRate")).toBe(true);
  });

  it("implausible resp outlier produces no signal", () => {
    expect(evaluate(baseline(60, 52, 100, 40)).signals.some((s) => s.key === "respRate")).toBe(false);
  });

  it("explicit today without matching row is insufficient", () => {
    const days = baseline(72, 46, 100);
    expect(evaluate(days, "2026-06-08").level).toBe("insufficient");
    expect(evaluate(days, "2024-03-29").level).not.toBe("insufficient");
    expect(evaluate(days).level).not.toBe("insufficient");
  });

  it("stats helpers", () => {
    expect(mean([2, 4, 6])).toBeCloseTo(4, 12);
    expect(sampleSD([2, 4, 6])).toBeCloseTo(2, 4);
    expect(sampleSD([5])).toBeNull();
    expect(mean([])).toBeNull();
  });
});

describe("plan U6: ACWR bands and monotony", () => {
  it("classifies 0.8 / 1.3 / 1.5 as noop does (lower bound inclusive); ramping down is informational", () => {
    expect(acwrSignal(0.79, 1, 1)).toMatchObject({ flag: "neutral", detail: "LOAD_RAMPING_DOWN" });
    expect(acwrSignal(0.8, 1, 1)).toMatchObject({ flag: "good", detail: "LOAD_SWEET_SPOT" });
    expect(acwrSignal(1.3, 1, 1)).toMatchObject({ flag: "watch", detail: "LOAD_BUILDING_FAST" });
    expect(acwrSignal(1.5, 1, 1)).toMatchObject({ flag: "bad", detail: "LOAD_SPIKING" });
  });

  it("monotony ≥ 2.0 sets the watch flag; below does not", () => {
    // Last week 12,10,12,10,12,10,12 → mean 11.14 / SD 1.07 ≈ 10.4.
    const flat = Array.from({ length: 28 }, (_, i) => d(i + 1, 60, 52, i % 2 === 0 ? 10 : 12));
    const r = evaluate(flat);
    expect(r.monotony!).toBeGreaterThanOrEqual(2);
    expect(r.signals.find((s) => s.key === "monotony")?.flag).toBe("watch");

    // Last week 20,0,20,0,20,0,20 → mean 11.43 / SD 10.69 ≈ 1.07.
    const varied = Array.from({ length: 28 }, (_, i) => d(i + 1, 60, 52, i % 2 === 0 ? 0 : 20));
    const v = evaluate(varied);
    expect(v.monotony!).toBeLessThan(2);
    expect(v.signals.some((s) => s.key === "monotony")).toBe(false);
  });
});

describe("ReadinessTrainingLoadTest", () => {
  const metric = (day: number, load: number | null, hrv = 60, rhr = 52): ReadinessDay => ({
    day: `2026-01-${pad(day)}`,
    rhr,
    hrv,
    load,
    resp: 14,
  });
  const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it("paired API leaves readiness unchanged", () => {
    const days = range(28).map((i) => metric(i, i <= 21 ? 50 : 150, i % 2 === 0 ? 62 : 58, i % 2 === 0 ? 54 : 50));
    const paired = evaluateWithTrainingLoad(days);
    expect(paired.readiness).toEqual(evaluate(days));
    expect(paired.trainingLoad.state).toBe("building");
    expect(paired.trainingLoad.ctl).not.toBeNull();
    expect(paired.trainingLoad.atl).not.toBeNull();
    expect(paired.trainingLoad.tsb).not.toBeNull();
  });

  it("ACWR and monotony stay owned by readiness", () => {
    const paired = evaluateWithTrainingLoad(range(28).map((i) => metric(i, i <= 21 ? 50 : 120 + 10 * (i % 3))));
    expect(paired.readiness.acwr).not.toBeNull();
    expect(paired.readiness.monotony).not.toBeNull();
    expect(paired.trainingLoad.state).not.toBe("unavailable");
    expect(paired.trainingLoad.endDay).toBe("2026-01-28");
  });

  it("one missing load is carried by the training model; four in a row break it; readiness never suppressed", () => {
    const one = evaluateWithTrainingLoad(range(28).map((i) => metric(i, i === 21 ? null : 10)));
    expect(one.readiness.level).not.toBe("insufficient");
    expect(one.trainingLoad.state).toBe("building");
    expect(one.trainingLoad.contiguousDays).toBe(27);

    const four = evaluateWithTrainingLoad(range(28).map((i) => metric(i, i >= 18 && i <= 21 ? null : 10)));
    expect(four.readiness.level).not.toBe("insufficient");
    expect(four.trainingLoad.state).toBe("unavailable");
    expect(four.trainingLoad.unavailableReason).toBe("NOT_ENOUGH_CONTIGUOUS_DAYS");
    expect(four.trainingLoad.contiguousDays).toBe(7);
  });

  it("explicit missing today fails closed for both", () => {
    const paired = evaluateWithTrainingLoad(range(28).map((i) => metric(i, 10)), "2026-02-01");
    expect(paired.readiness.level).toBe("insufficient");
    expect(paired.trainingLoad.state).toBe("unavailable");
    expect(paired.trainingLoad.unavailableReason).toBe("MISSING_TARGET_DAY");
  });

  it("explicit today ignores future training rows", () => {
    const paired = evaluateWithTrainingLoad(range(28).map((i) => metric(i, i <= 20 ? 10 : 100)), "2026-01-20");
    expect(paired.trainingLoad.endDay).toBe("2026-01-20");
    expect(paired.trainingLoad.contiguousDays).toBe(20);
    expect(paired.trainingLoad.points.at(-1)!.load).toBe(10);
  });
});

describe("Readiness and the early-baseline fix", () => {
  const rhrs = Array.from({ length: 28 }, (_, i) => (i % 2 === 0 ? 56 : 48));
  const days = (todayRhr: number) => [...rhrs.map((r, i) => d(i + 1, 60, r, 10)), d(29, 60, todayRhr, 10)];
  // Readiness re-folds its trailing window with hard-outlier rejection off.
  const state = foldHistory(rhrs, restingHRCfg, false);

  it("learns the window's real spread (±4 bpm), not the 2 bpm floor plus a slow climb", () => {
    // Before the fix the 2 bpm seed still held about 30 % weight after 28 nights (spread ≈ 3.4).
    expect(Math.abs(state.spread - 4)).toBeLessThan(0.3);
  });

  it("does not apply the n / (n + 2) shrink: its window never grows, so the shrink would never fade", () => {
    // Raw z = −0.52 is "watch"; shrunk by 28/30 it would be −0.485, "neutral".
    const r = evaluate(days(state.baseline + 0.52 * sigma(state)));
    expect(flagOf(r, "rhr")).toBe("watch");
    expect(flagOf(evaluate(days(state.baseline + 0.48 * sigma(state))), "rhr")).toBe("neutral");
  });
});

describe("training load on linear TRIMP (SCORING_VERSION 10)", () => {
  const iso = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
  const rows = (loads: (number | null)[]): ReadinessDay[] => loads.map((load, i) => ({ day: iso(i), load }));
  // A usual week: 4 workouts of 118 TRIMP and 3 rest days of 9 (the seed's typical days: Effort 53.8 and 25.9).
  const usual = [118, 9, 118, 9, 118, 118, 9];
  const weeks = (lastWeek: number[]) => [...usual, ...usual, ...usual, ...lastWeek];
  const acwrOf = (loads: (number | null)[]) => evaluate(rows(loads)).acwr;
  /** The same days fed as Effort (the version 9 input), to document what the log map hid. */
  const asEffort = (loads: number[]) => loads.map((t) => trimpToStrain(t));

  it("the fix list's check: 2× the usual load for a week reads 1.60 (coupled 7/28)", () => {
    expect(acwrOf(weeks(usual.map((t) => 2 * t)))).toBeCloseTo(1.6, 2);
    expect(acwrOf(weeks(usual))).toBeCloseTo(1.0, 12);
    // Coupled: acute / (acute + 3 × prior) × 4, so k× the usual load always reads 4k / (k + 3).
    for (const k of [0.5, 1.5, 3]) expect(acwrOf(weeks(usual.map((t) => k * t)))).toBeCloseTo((4 * k) / (k + 3), 12);
  });

  it("workouts 3× harder spike on TRIMP; on Effort the same week stayed in the sweet spot", () => {
    const hard = weeks(usual.map((t) => (t > 9 ? 3 * t : t)));
    const r = evaluate(rows(hard));
    expect(acwrBand(r.acwr!)).toBe("LOAD_SPIKING");
    expect(r.signals.find((x) => x.key === "acwr")?.flag).toBe("bad");
    expect(acwrBand(acwrOf(asEffort(hard))!)).toBe("LOAD_SWEET_SPOT"); // 1.12: the version 9 reading
  });

  it("an ordinary 4-workout week is not monotonous on TRIMP (it was 2.81 on Effort)", () => {
    const r = evaluate(rows(weeks(usual)));
    expect(r.monotony!).toBeLessThan(2);
    expect(r.signals.some((x) => x.key === "monotony")).toBe(false);
    expect(evaluate(rows(asEffort(weeks(usual)))).monotony!).toBeGreaterThan(2.5);
  });

  it("a week with no rest days at the usual session load builds fast but does not spike", () => {
    const r = evaluate(rows(weeks(Array(7).fill(118))));
    expect(acwrBand(r.acwr!)).toBe("LOAD_BUILDING_FAST");
  });

  it("windows are calendar days: an unworn day in the week is not replaced by an older day", () => {
    // 21 days at 100, then a week at 10 with one unworn day. By rows, "last 7" would reach back to a 100.
    const loads = [...Array(21).fill(100), 10, 10, 10, null, 10, 10, 10];
    const r = evaluate(rows(loads));
    const acute = r.signals.find((x) => x.key === "acwr")!.evidence as { acute: number; chronic: number };
    expect(acute.acute).toBe(10);
    expect(acute.chronic).toBeCloseTo((21 * 100 + 6 * 10) / 27, 12);
  });

  it("rows after today are ignored", () => {
    const loads = weeks(usual);
    const withFuture = [...rows(loads), { day: iso(28), load: 5000 }, { day: iso(29), load: 5000 }];
    expect(evaluate(withFuture, iso(27)).acwr).not.toBeNull();
    expect(evaluate(withFuture, iso(27)).acwr).toBe(evaluate(rows(loads)).acwr);
    expect(evaluate(withFuture, iso(27)).monotony).toBe(evaluate(rows(loads)).monotony);
  });

  it("days older than 28 do not count, so a long-ago heavy block is forgotten", () => {
    const loads = [...Array(30).fill(1000), ...weeks(usual)];
    expect(acwrOf(loads)).toBeCloseTo(1.0, 12);
  });

  it(`gates: at least ${minAcute} loads in the last 7 days and ${minChronic} in the last 28`, () => {
    const acuteN = (n: number) => [...Array(21).fill(50), ...Array(7 - n).fill(null), ...Array(n).fill(50)];
    expect(acwrOf(acuteN(minAcute - 1))).toBeNull();
    expect(acwrOf(acuteN(minAcute))).toBeCloseTo(1, 12);
    const chronicN = (n: number) => [...Array(28 - n).fill(null), ...Array(n).fill(50)];
    expect(acwrOf(chronicN(minChronic - 1))).toBeNull();
    expect(acwrOf(chronicN(minChronic))).toBeCloseTo(1, 12);
    // Monotony shares the gates.
    expect(evaluate(rows(acuteN(minAcute - 1))).monotony).toBeNull();
  });

  it("identical days give no monotony, not ~3e15 from floating-point noise", () => {
    // 25.92 × 7 has an SD of ~1e-14 in floating point, which passed the old `sd > 0` check.
    for (const v of [25.92, 118, 0.1, 1e6]) {
      const r = evaluate(rows(Array(28).fill(v)));
      // The gates passed, so monotony was considered; under 30 a day it is a light load with no ratio (version 27).
      if (v >= 30) expect(r.acwr).toBeCloseTo(1, 12);
      else expect(r).toMatchObject({ acwr: null, lightLoad: true });
      expect(r.monotony).toBeNull();
      expect(r.signals.some((x) => x.key === "monotony")).toBe(false);
    }
  });

  it("a week of only rest (0 load) has no ratio when the month is all zero, and no monotony", () => {
    const r = evaluate(rows(Array(28).fill(0)));
    expect(r.acwr).toBeNull();
    expect(r.monotony).toBeNull();
  });

  it("ramping down is informational: band kept, flag neutral, and it does not block primed", () => {
    // HRV and RHR clearly good (two "good" signals); a light week (deload) as the only other signal.
    const days: ReadinessDay[] = [];
    for (let i = 0; i < 28; i++) days.push({ day: iso(i), hrv: i % 2 ? 62 : 58, rhr: i % 2 ? 54 : 50, load: i < 21 ? 100 : 20 });
    days.push({ day: iso(28), hrv: 72, rhr: 46, load: 20 });
    const r = evaluate(days);
    const acwr = r.signals.find((x) => x.key === "acwr")!;
    expect(acwr.detail).toBe("LOAD_RAMPING_DOWN");
    expect(acwr.flag).toBe("neutral");
    expect(r.level).toBe("primed");
  });

  it("CTL/ATL run on the same load as the ratio", () => {
    const loads = weeks(usual);
    const paired = evaluateWithTrainingLoad(rows(loads));
    expect(paired.trainingLoad.points.map((p) => p.load)).toEqual(loads.slice(6));
  });
});

describe("a light load has no ratio (SCORING_VERSION 27)", () => {
  const iso = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
  const rows = (loads: number[]): ReadinessDay[] => loads.map((load, i) => ({ day: iso(i), load }));
  /** 21 days at `base`, then 7 at `week` (so chronic = (21 × base + 7 × week) / 28 and acute = week). */
  const month = (base: number, week: number) => rows([...Array(21).fill(base), ...Array(7).fill(week)]);

  it("weeks of rest and one 40-TRIMP walk: no ratio, no load signal, not strained (version 26: spiking, strained)", () => {
    const r = evaluate(rows([...Array(55).fill(3), 40]));
    expect(r).toMatchObject({ acwr: null, lightLoad: true });
    expect(r.signals.some((x) => x.key === "acwr")).toBe(false);
    expect(r.level).not.toBe("strained");
    // The plain ratio it used to give: (6 × 3 + 40) / 7 ÷ (27 × 3 + 40) / 28 = 1.92.
    expect(((6 * 3 + 40) / 7 / ((27 * 3 + 40) / 28)).toFixed(2)).toBe("1.92");
  });

  it("chronic exactly at the floor uses the plain ratio; just under it uses the floor", () => {
    expect(acwrChronicFloor).toBe(30);
    const at = evaluate(month(30, 30));
    expect(at).toMatchObject({ acwr: 1, lightLoad: false });
    // Chronic 29.9 and acute 29.9: under the floor, and 29.9 / 30 < 1.3, so light.
    expect(evaluate(month(29.9, 29.9))).toMatchObject({ acwr: null, lightLoad: true });
  });

  it("under the floor, acute ÷ floor below 1.3 is light; from 1.3 it is building fast, from 1.5 spiking", () => {
    expect(lightLoadJump).toBe(1.3);
    // A chronic load under 30 throughout: 21 days of 5, then a week at acute = 30 × the target ratio.
    const at = (ratio: number) => evaluate(month(5, 30 * ratio));
    expect(at(1.29)).toMatchObject({ acwr: null, lightLoad: true });
    const building = at(1.3);
    expect(building.acwr).toBeCloseTo(1.3, 12);
    expect(building.signals.find((x) => x.key === "acwr")).toMatchObject({ detail: "LOAD_BUILDING_FAST", flag: "watch", evidence: { floor: 30 } });
    const spiking = at(1.5);
    expect(spiking.signals.find((x) => x.key === "acwr")).toMatchObject({ detail: "LOAD_SPIKING", flag: "bad" });
    expect(spiking.level).toBe("strained");
    // Each case really had chronic under the floor.
    expect((21 * 5 + 7 * 30 * 1.5) / 28).toBeLessThan(30);
  });

  it("a sedentary person who starts running 5 days a week still reads spiking", () => {
    const loads = [...Array(56).fill(4), ...[120, 120, 120, 120, 120, 4, 4]];
    const r = evaluate(rows(loads));
    expect(r.signals.find((x) => x.key === "acwr")?.detail).toBe("LOAD_SPIKING");
  });

  it("over the floor nothing changes: the plain ratio and its band", () => {
    const r = evaluate(month(60, 90));
    expect(r.acwr).toBeCloseTo(90 / ((21 * 60 + 7 * 90) / 28), 12);
    expect(r.lightLoad).toBe(false);
    expect(r.signals.find((x) => x.key === "acwr")?.evidence).toEqual({ kind: "trainingLoad", acute: 90, chronic: (21 * 60 + 7 * 90) / 28 });
  });
});
