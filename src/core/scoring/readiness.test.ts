import { describe, expect, it } from "vitest";
import { foldHistory, restingHRCfg, sigma } from "./baselines";
import { acwrBand, acwrChronicFloor, acwrConfig, acwrPrimeDays, acwrSignal, dayRatio, evaluate, evaluateWithTrainingLoad, ewmaLoads, lightLoadJump, mean, minAcute, minChronic, monotonyMax, type ReadinessDay, sampleSD } from "./readiness";
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

  it("monotony is reported high or low, capped at monotonyMax, and is never a signal (version 47)", () => {
    // Last week 12,10,12,10,12,10,12 → mean 11.14 / SD 1.07 ≈ 10.4, capped at 10. Version 46 flagged it "watch".
    const flat = Array.from({ length: 28 }, (_, i) => d(i + 1, 60, 52, i % 2 === 0 ? 10 : 12));
    const r = evaluate(flat);
    expect(r.monotony).toBe(monotonyMax);
    expect(r.signals.map((s) => s.key)).not.toContain("monotony");

    // Last week 20,0,20,0,20,0,20 → mean 11.43 / SD 10.69 ≈ 1.07.
    const varied = Array.from({ length: 28 }, (_, i) => d(i + 1, 60, 52, i % 2 === 0 ? 0 : 20));
    expect(evaluate(varied).monotony).toBeCloseTo(1.07, 2);
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

  it("2× the usual load for a week builds fast (1.37; the coupled 7/28 means read 1.60 until version 45)", () => {
    expect(acwrOf(weeks(usual.map((t) => 2 * t)))).toBeCloseTo(1.37, 2);
    expect(acwrBand(acwrOf(weeks(usual.map((t) => 2 * t)))!)).toBe("LOAD_BUILDING_FAST");
    // The plain ratio it replaced: k× the usual load for a week read 4k / (k + 3).
    expect((4 * 2) / (2 + 3)).toBe(1.6);
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
    expect(evaluate(rows(asEffort(weeks(usual)))).monotony!).toBeGreaterThan(2.5);
  });

  it("a week with no rest days at the usual session load (1.65× the week) stays in the sweet spot; a second one builds fast", () => {
    // Version 44's 7/28 means read 1.40 (building fast) after one week.
    expect(acwrOf(weeks(Array(7).fill(118)))).toBeCloseTo(1.28, 2);
    expect(acwrBand(acwrOf([...usual, ...usual, ...usual, ...Array(14).fill(118)])!)).toBe("LOAD_BUILDING_FAST");
  });

  it("an unworn day takes no EWMA step: the ratio is the same as without its row", () => {
    // 21 days at 100, then a week at 10 with one unworn day.
    const loads = [...Array(21).fill(100), 10, 10, 10, null, 10, 10, 10];
    const ev = evaluate(rows(loads)).signals.find((x) => x.key === "acwr")!.evidence as { acute: number; chronic: number };
    expect(ev).toMatchObject(ewmaLoads(rows(loads.filter((l) => l != null)))!);
    expect(ev).not.toMatchObject(ewmaLoads(rows(loads.map((l) => l ?? 0)))!);
  });

  it("rows after today are ignored", () => {
    const loads = weeks(usual);
    const withFuture = [...rows(loads), { day: iso(28), load: 5000 }, { day: iso(29), load: 5000 }];
    expect(evaluate(withFuture, iso(27)).acwr).not.toBeNull();
    expect(evaluate(withFuture, iso(27)).acwr).toBe(evaluate(rows(loads)).acwr);
    expect(evaluate(withFuture, iso(27)).monotony).toBe(evaluate(rows(loads)).monotony);
  });

  it("a long-ago heavy block fades with the chronic time constant (τ 42) instead of dropping out on day 29", () => {
    // 30 days at 14× the usual load: 4 weeks later the ratio still reads ramping down (informational), and after
    // 17 weeks the block's share of chronic is e^(−119/42) ≈ 6 % of the excess.
    expect(acwrBand(acwrOf([...Array(30).fill(1000), ...weeks(usual)])!)).toBe("LOAD_RAMPING_DOWN");
    const later = acwrOf([...Array(30).fill(1000), ...Array(17).fill(usual).flat()])!;
    expect(later).toBeGreaterThan(acwrOf([...Array(30).fill(1000), ...weeks(usual)])!);
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

  it("identical days are the most monotonous week (the cap), not ~3e15 from floating-point noise or none", () => {
    // 25.92 × 7 has an SD of ~1e-14 in floating point, which passed the old `sd > 0` check. Versions 10–46 gave null.
    for (const v of [25.92, 118, 0.1, 1e6]) {
      const r = evaluate(rows(Array(28).fill(v)));
      // The gates passed, so monotony was considered; under 30 a day it is a light load with no ratio (version 27).
      if (v >= 30) expect(r.acwr).toBeCloseTo(1, 12);
      else expect(r).toMatchObject({ acwr: null, lightLoad: true });
      expect(r.monotony).toBe(monotonyMax);
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
    expect(dayRatio({ acute: 38.9, chronic: 10 })).toBe("light");
    expect(dayRatio({ acute: 39, chronic: 10 })).toEqual({ ratio: 1.3, acute: 39, chronic: 10, floor: 30 });
    expect(acwrBand((dayRatio({ acute: 45, chronic: 10 }) as { ratio: number }).ratio)).toBe("LOAD_SPIKING");
    // Through evaluate: 21 days of 5, then a week at 80. Chronic stays under 30; acute ÷ 30 is 1.75.
    const spiking = evaluate(month(5, 80));
    const ev = ewmaLoads(month(5, 80))!;
    expect(ev.chronic).toBeLessThan(30);
    expect(spiking.acwr).toBeCloseTo(ev.acute / 30, 12);
    expect(spiking.signals.find((x) => x.key === "acwr")).toMatchObject({ detail: "LOAD_SPIKING", flag: "bad", evidence: { floor: 30 } });
    expect(spiking.level).toBe("strained");
    // A smaller week that stays under 1.3 × the floor is light.
    expect(evaluate(month(5, 40))).toMatchObject({ acwr: null, lightLoad: true });
  });

  it("a sedentary person who starts running 5 days a week still reads spiking", () => {
    const loads = [...Array(56).fill(4), ...[120, 120, 120, 120, 120, 4, 4]];
    const r = evaluate(rows(loads));
    expect(r.signals.find((x) => x.key === "acwr")?.detail).toBe("LOAD_SPIKING");
  });

  it("over the floor: the EWMA ratio and its band, in closed form", () => {
    // Seeded at 60, then 7 steps toward 90: each EWMA closes all but e^(−7/τ) of the gap.
    const acute = 90 - 30 * Math.exp(-7 / 7);
    const chronic = 90 - 30 * Math.exp(-7 / 42);
    const r = evaluate(month(60, 90));
    expect(r.acwr).toBeCloseTo(acute / chronic, 12);
    expect(r.lightLoad).toBe(false);
    const ev = r.signals.find((x) => x.key === "acwr")?.evidence as { acute: number; chronic: number };
    expect(ev.acute).toBeCloseTo(acute, 12);
    expect(ev.chronic).toBeCloseTo(chronic, 12);
  });
});

describe("the ratio is EWMA acute ÷ EWMA chronic (SCORING_VERSION 45)", () => {
  const iso = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
  const rows = (loads: (number | null)[]): ReadinessDay[] => loads.map((load, i) => ({ day: iso(i), load }));
  /** Version 44's ratio: the mean of the last 7 calendar days' loads over the last 28's. */
  const plain = (loads: number[]) => mean(loads.slice(-7))! / mean(loads.slice(-28))!;

  it("uses Fitness' ATL and CTL time constants (τ 7 and 42) and its 7-day seed", () => {
    expect(acwrConfig).toEqual({ acuteTau: 7, chronicTau: 42 });
    expect(acwrPrimeDays).toBe(7);
  });

  it("matches trainingLoad's ATL and CTL on a gapless history", () => {
    const loads = Array.from({ length: 60 }, (_, i) => [118, 9, 118, 9, 118, 118, 9][i % 7] + i);
    const tl = evaluateWithTrainingLoad(rows(loads)).trainingLoad;
    const ev = ewmaLoads(rows(loads))!;
    expect(ev.acute).toBeCloseTo(tl.atl!, 9);
    expect(ev.chronic).toBeCloseTo(tl.ctl!, 9);
  });

  it("seeds both from the mean of the first 7 loaded days, then steps by 1 − e^(−1/τ)", () => {
    const loads = [10, 20, 30, 40, 50, 60, 70, 100];
    const seed = 40;
    expect(ewmaLoads(rows(loads.slice(0, 7)))).toEqual({ acute: seed, chronic: seed });
    const ev = ewmaLoads(rows(loads))!;
    expect(ev.acute).toBeCloseTo(seed + (1 - Math.exp(-1 / 7)) * (100 - seed), 12);
    expect(ev.chronic).toBeCloseTo(seed + (1 - Math.exp(-1 / 42)) * (100 - seed), 12);
    expect(ewmaLoads(rows([null, null]))).toBeNull();
  });

  it("row order does not matter", () => {
    const r = rows([50, 60, 70, 80, 90, 100, 110, 120, 30]);
    expect(ewmaLoads([...r].reverse())).toEqual(ewmaLoads(r));
  });

  it("a constant load reads exactly 1", () => {
    expect(evaluate(rows(Array(60).fill(80))).acwr).toBe(1);
  });

  it("a session leaving the week moves the ratio a little, not by a seventh of the week at once", () => {
    const usual = [118, 9, 118, 9, 118, 118, 9];
    // A session, then six rest days: the next rest day is the morning the session drops out of a 7-day window.
    const inWindow = [...Array(6).fill(usual).flat(), 118, 9, 9, 9, 9, 9, 9];
    const dropped = [...inWindow, 9];
    const ewma = evaluate(rows(inWindow)).acwr! - evaluate(rows(dropped)).acwr!;
    const old = plain(inWindow) - plain(dropped);
    expect(old).toBeGreaterThan(0.2);
    expect(ewma).toBeLessThan(old / 4);
  });

  it("an unworn stretch takes no steps, so a week off with the band off leaves the ratio where it was", () => {
    const loads = Array.from({ length: 42 }, (_, i) => (i % 2 ? 100 : 20));
    const before = evaluate(rows(loads)).acwr!;
    // 7 unworn days, then 4 days back at the same pattern (the gates need 4 loads in the week).
    const after = evaluate(rows([...loads, ...Array(7).fill(null), 100, 20, 100, 20])).acwr!;
    expect(Math.abs(after - before)).toBeLessThan(0.1);
  });
});

describe("the load signals run through yesterday when today is still going (SCORING_VERSION 46)", () => {
  const iso = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
  const usual = [118, 9, 118, 9, 118, 118, 9];
  const days = (todayLoad: number | null, todayHrv = 60): ReadinessDay[] => [
    ...Array.from({ length: 41 }, (_, i) => ({ day: iso(i), hrv: i % 2 ? 62 : 58, rhr: i % 2 ? 54 : 50, load: usual[i % 7] })),
    { day: iso(41), hrv: todayHrv, rhr: 52, load: todayLoad },
  ];

  it("today's load, morning or evening, changes nothing: ratio, light load, monotony and level", () => {
    const morning = evaluate(days(2), null, undefined, "yesterday");
    for (const evening of [0, 118, 400, null]) {
      const r = evaluate(days(evening), null, undefined, "yesterday");
      expect(r).toMatchObject({ acwr: morning.acwr, lightLoad: morning.lightLoad, monotony: morning.monotony, level: morning.level });
    }
    // Through today the morning and the evening differ (version 45).
    expect(evaluate(days(2)).acwr).not.toBe(evaluate(days(400)).acwr);
  });

  it("is the ratio through today of the rows up to yesterday", () => {
    const r = evaluate(days(400), null, undefined, "yesterday");
    const upToYesterday = evaluate(days(400).slice(0, -1));
    expect(r.acwr).toBe(upToYesterday.acwr);
    expect(r.monotony).toBe(upToYesterday.monotony);
  });

  it("the gates count windows ending yesterday", () => {
    // Loads only on the 14 days ending yesterday, and today: through yesterday the gates pass; a gap yesterday fails them.
    const rows: ReadinessDay[] = Array.from({ length: 15 }, (_, i) => ({ day: iso(i), load: 50 }));
    expect(evaluate(rows, null, undefined, "yesterday").acwr).toBe(1);
    const gapYesterday = rows.map((r, i) => (i === 13 ? { ...r, load: null } : r));
    expect(evaluate(gapYesterday, null, undefined, "yesterday").acwr).toBeNull();
    expect(evaluate(gapYesterday).acwr).toBe(1);
  });

  it("HRV and resting HR still read today's night", () => {
    const low = evaluate(days(2, 30), null, undefined, "yesterday");
    expect(low.signals.find((x) => x.key === "hrv")?.flag).toBe("bad");
    expect(evaluate(days(2, 60), null, undefined, "yesterday").signals.find((x) => x.key === "hrv")?.flag).not.toBe("bad");
  });

  it("evaluateWithTrainingLoad passes it on; CTL/ATL still run through today", () => {
    const a = evaluateWithTrainingLoad(days(2), null, undefined, "yesterday");
    const b = evaluateWithTrainingLoad(days(400), null, undefined, "yesterday");
    expect(a.readiness.acwr).toBe(b.readiness.acwr);
    expect(a.trainingLoad.atl).not.toBe(b.trainingLoad.atl);
  });
});

describe("monotony is information only (SCORING_VERSION 47)", () => {
  const iso = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
  // 8 weeks, then today: HRV and RHR clearly good (two "good" signals) and the ratio in the sweet spot.
  const person = (load: (i: number) => number): ReadinessDay[] => [
    ...Array.from({ length: 56 }, (_, i) => ({ day: iso(i), hrv: i % 2 ? 62 : 58, rhr: i % 2 ? 54 : 50, resp: 14, load: load(i) })),
    { day: iso(56), hrv: 72, rhr: 46, resp: 14, load: 0 },
  ];
  // A fixed ±20 % pattern, so the weeks vary without a random generator.
  const vary = [0.8, 1.2, 1.0, 0.9, 1.15, 0.85, 1.1];
  const daily = (i: number) => 150 * vary[i % 7];

  it.each([
    ["a daily trainer (150 ± 20 %)", daily, 4],
    ["one rest day a week", (i: number) => (i % 7 === 6 ? 0 : daily(i)), 2],
    ["a daily 40-TRIMP walker", (i: number) => 40 * vary[i % 7], 4],
    ["identical days", () => 150, monotonyMax],
  ])("%s with good HRV and RHR is primed; monotony is still reported (version 46: balanced)", (_, load, atLeast) => {
    const r = evaluate(person(load), iso(56), undefined, "yesterday");
    expect(r.monotony!).toBeGreaterThanOrEqual(atLeast);
    expect(r.signals.map((s) => [s.key, s.flag])).toEqual([["hrv", "good"], ["rhr", "good"], ["acwr", "good"]]);
    expect(r.level).toBe("primed");
  });

  it("the level is the same whatever the week's spread, at the same ratio", () => {
    // Same weekly total every week: one session of 7 × 100 or 7 days of 100. The EWMA ratio differs slightly, so
    // compare the level and the signals' flags, which monotony used to change.
    const spread = evaluate(person((i) => (i % 7 === 0 ? 700 : 0)), iso(56), undefined, "yesterday");
    const flat = evaluate(person(() => 100), iso(56), undefined, "yesterday");
    expect(spread.monotony!).toBeLessThan(1);
    expect(flat.monotony).toBe(monotonyMax);
    expect([spread.level, flat.level]).toEqual(["primed", "primed"]);
    expect(flat.signals.filter((s) => s.flag !== "good")).toEqual([]);
  });

  it("a week of zeros with enough rows has no monotony (nothing to compare)", () => {
    const r = evaluate([...Array(28)].map((_, i) => ({ day: iso(i), load: i < 21 ? 100 : 0 })));
    expect(r.monotony).toBeNull();
  });
});
