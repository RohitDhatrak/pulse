import { describe, expect, it } from "vitest";
import {
  allNighterConfig,
  awakeAllNight,
  creditedSleepMin,
  debtSeries,
  defaultSleepNeedHours,
  hypnogramMetrics,
  ledger,
  maxNeedHours,
  needQuantile,
  nightSummary,
  personalizedNeedHours,
  populationNeedFloorHours,
  rest,
  restFromTotals,
  restorativeTargetShare,
  restorativeScore,
  round1,
  sleepConsistency,
  minUsualRestorativeNights,
  usualRestorativeNights,
  wConsistency,
  wDuration,
  wEfficiency,
  wRestorative,
} from "./sleep";

const H = 3600;
const EPS = 9;

describe("hypnogramMetrics", () => {
  it("AASM aggregates; an 'awake' segment counts as WASO", () => {
    const m = hypnogramMetrics({
      start: 0,
      end: 1200,
      stages: [
        { start: 900, end: 960, stage: "awake" },
        { start: 0, end: 60, stage: "wake" },
        { start: 60, end: 600, stage: "light" },
        { start: 600, end: 900, stage: "deep" },
        { start: 960, end: 1200, stage: "rem" },
      ],
    });
    expect(m).toMatchObject({ tibS: 1200, tstS: 1080, sptS: 1140, solS: 60, remLatencyS: 900, wasoS: 60, disturbances: 1 });
    expect(m.efficiency).toBeCloseTo(0.9, 12);
    expect([m.deepMin, m.remMin, m.lightMin]).toEqual([5, 4, 9]);
    expect(m.deepPct).toBeCloseTo((300 / 1080) * 100, 12);
    expect(m.lightPct).toBeCloseTo(50, 12);
  });

  it("a night with no sleep stages", () => {
    const m = hypnogramMetrics({ start: 0, end: 600, stages: [{ start: 0, end: 600, stage: "wake" }] });
    expect(m).toMatchObject({ tstS: 0, solS: 600, sptS: 0, remLatencyS: null, wasoS: 0, efficiency: 0, deepPct: 0 });
  });
});

describe("ChargeEffortRestScoringTest: Rest", () => {
  it("weight constants", () => {
    expect([wDuration, wEfficiency, wRestorative, wConsistency, defaultSleepNeedHours, restorativeTargetShare]).toEqual([
      0.5, 0.2, 0.2, 0.1, 7.5, 0.5,
    ]);
  });

  it("null when there is no asleep time", () => {
    expect(rest(0, 0.9, 0, 0)).toBeNull();
  });

  it("no consistency uses a neutral 50 at full weight", () => {
    expect(rest(8 * H, 0.92, 1.5 * H, 2 * H)).toBeCloseTo(100 * 0.5 + 92 * 0.2 + 87.5 * 0.2 + 50 * 0.1, EPS);
  });

  it("the consistency term is included", () => {
    expect(rest(8 * H, 0.92, 1.5 * H, 2 * H, null, 0.8)).toBeCloseTo(100 * 0.5 + 92 * 0.2 + 87.5 * 0.2 + 80 * 0.1, EPS);
  });

  it("duration dominates a short night (noop's case, at an 8 h need)", () => {
    expect(rest(4 * H, 0.95, H, H, 8)).toBeCloseTo(50 * 0.5 + 95 * 0.2 + 100 * 0.2 + 50 * 0.1, EPS);
  });

  it("a refined lower need raises duration; oversleep clamps at 100", () => {
    expect(rest(6 * H, 0.9, H, 1.5 * H, 6)!).toBeGreaterThan(rest(6 * H, 0.9, H, 1.5 * H)!);
    const share = (2 + 2.5) / 10;
    expect(rest(10 * H, 0.9, 2 * H, 2.5 * H)).toBeCloseTo(100 * 0.5 + 90 * 0.2 + (share / 0.5) * 100 * 0.2 + 50 * 0.1, EPS);
  });

  it("low deep share scales the restorative term down to half", () => {
    // 8 h, no deep, 4 h REM: share 0.5 → 100, deep factor 0.5 → 50.
    expect(rest(8 * H, 0.9, 0, 4 * H)).toBeCloseTo(100 * 0.5 + 90 * 0.2 + 50 * 0.2 + 50 * 0.1, EPS);
  });

  it("restFromTotals reads a night's stored minutes", () => {
    expect(restFromTotals({ totalSleepMin: 420, efficiency: 0.85, deepMin: 80, remMin: 90 })).toBe(
      rest(420 * 60, 0.85, 80 * 60, 90 * 60, null, null),
    );
    expect(restFromTotals({ totalSleepMin: null, efficiency: 0.85, deepMin: 80, remMin: 90 })).toBeNull();
    expect(restFromTotals({ totalSleepMin: 0, efficiency: 0.85, deepMin: null, remMin: null })).toBeNull();
  });
});

describe("RestNeedTest", () => {
  it("a chronic under-sleeper stays at the floor", () => {
    expect(personalizedNeedHours(Array(14).fill(5.5), 30)).toBeGreaterThanOrEqual(7);
  });
  it("a normal sleeper reflects unrestricted nights", () => {
    const need = personalizedNeedHours([7.2, 7.8, 8.1, 7.5, 8.4, 7.9, 8.0, 7.6, 8.2, 7.7], 35);
    expect(need).toBeGreaterThanOrEqual(7.8);
    expect(need).toBeLessThanOrEqual(9.5);
  });
  it("cold start returns the population default", () => {
    expect(personalizedNeedHours([7, 8, 6.5], 30)).toBeCloseTo(defaultSleepNeedHours, 3);
  });
  it("caps a long sleeper; minors get a higher floor; null age uses the adult floor", () => {
    expect(personalizedNeedHours(Array(10).fill(11), 40)).toBeLessThanOrEqual(9.5);
    expect(personalizedNeedHours(Array(10).fill(6), 15)).toBeGreaterThanOrEqual(8);
    expect(personalizedNeedHours(Array(10).fill(5), null)).toBeGreaterThanOrEqual(7);
  });
  it("zero and negative nights are ignored", () => {
    expect(personalizedNeedHours([0, -1, 7.5, 8, 7.8, 8.2, 7.6, 8.1, 7.9, 8.3, 0], 30)).toBeGreaterThanOrEqual(7.5);
  });
});

describe("plan scenarios: need (SCORING_VERSION 15: median, adult floor 7 h, 7.5 h before 7 nights)", () => {
  it("under 7 nights is 7.5 h (9 under 18); the clamp holds at 7–9.5 h", () => {
    expect(personalizedNeedHours([9.5, 9.5, 9.5, 9.5, 9.5, 9.5], 30)).toBe(7.5);
    expect(personalizedNeedHours([9.5, 9.5, 9.5], 16)).toBe(9);
    expect(personalizedNeedHours(Array(7).fill(6), 30)).toBe(7);
    expect(personalizedNeedHours(Array(7).fill(12), 30)).toBe(maxNeedHours);
    // Median of 7..13 (step 1) is 10.
    expect(personalizedNeedHours([7, 8, 9, 10, 11, 12, 13], 30)).toBe(9.5);
    expect(personalizedNeedHours([6.5, 7, 7.5, 8, 8.5, 9, 9.25], 30)).toBe(8);
    // Median of 8.0..8.6 (step 0.1) is 8.3 (the upper quartile, version 14, was 8.45).
    expect(personalizedNeedHours([8.0, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6], 30)).toBeCloseTo(8.3, 12);
  });

  it("the floor is 7 h asleep for adults (and an unknown age), 9 h under 18", () => {
    expect([17, 18, 30, 70, null, 0].map(populationNeedFloorHours)).toEqual([9, 7, 7, 7, 7, 7]);
  });

  it("the median interpolates on an even count, and ignores nights of 0 or less", () => {
    expect(personalizedNeedHours([7, 7.2, 7.4, 7.6, 7.8, 8.0, 8.2, 8.4], 30)).toBeCloseTo(7.7, 12);
    expect(personalizedNeedHours([0, -1, 7, 7.2, 7.4, 7.6, 7.8, 8.0, 8.2, 8.4, 0], 30)).toBeCloseTo(7.7, 12);
    expect(needQuantile).toBe(0.5);
  });
});

describe("sleepers over 45 nights (SCORING_VERSION 15 design check)", () => {
  /** Nights of `mean` ± `sd` hours asleep (deterministic), with need, score and debt as the pipeline computes them. */
  const simulate = (mean: number, sd: number, override: (d: number) => number | null = () => null, needOf = personalizedNeedHours) => {
    let x = 3;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648), x / 2147483648);
    const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
    const hours: number[] = [];
    const series: [string, number][] = [];
    return Array.from({ length: 45 }, (_, d) => {
      const h = override(d) ?? Math.max(4, mean + sd * g());
      const need = needOf(hours.slice(-28), 35);
      const score = rest(h * H, 0.88, 0.15 * h * H, 0.22 * h * H, need, 0.9)!;
      series.push([new Date(Date.UTC(2026, 8, 1 + d)).toISOString().slice(0, 10), h * 60]);
      const debt = ledger(series, need).magnitudeMin;
      hours.push(h);
      return { need, score, debt, durationScore: Math.min(100, (h / need) * 100) };
    });
  };
  const late = (xs: { debt: number }[]) => xs.slice(30).reduce((a, n) => a + n.debt, 0) / 15;
  /** Version 14's rule: the upper quartile, floored at 8 h (8 h before 7 nights). */
  const v14Need = (xs: number[]) => {
    const s = xs.filter((h) => h > 0).sort((a, b) => a - b);
    if (s.length < 7) return 8;
    const pos = 0.75 * (s.length - 1);
    const lo = Math.floor(pos);
    return Math.min(Math.max(s[lo] + (pos - lo) * (s[Math.min(lo + 1, s.length - 1)] - s[lo]), 8), 9.5);
  };

  it("a steady 7 h sleeper: need 7, no debt, full duration score (version 14: 73 min of debt every day)", () => {
    const nights = simulate(7, 0).slice(7);
    for (const n of nights) {
      expect(n.need).toBe(7);
      expect(n.debt).toBe(0);
      expect(n.durationScore).toBe(100);
    }
    expect(late(simulate(7, 0, () => null, v14Need))).toBeCloseTo(73.3, 0);
  });

  it("healthy 7, 7.5 and 8 h sleepers who vary ±0.5 h carry at most 15 min of debt", () => {
    for (const h of [7, 7.5, 8]) expect(late(simulate(h, 0.5)), `${h} h`).toBeLessThanOrEqual(15);
    // Version 14 (and the fix list's floor 7 with the upper quartile) left a varied 8 h sleeper in debt.
    expect(late(simulate(8, 0.5, () => null, v14Need))).toBeGreaterThan(15);
  });

  it("a 6.5 h sleeper, below the recommended 7–9 h, still shows debt", () => {
    expect(late(simulate(6.5, 0.5))).toBeGreaterThanOrEqual(25);
  });

  it("five nights 1.5 h short still build real debt", () => {
    const nights = simulate(7.5, 0.3, (d) => (d >= 35 && d < 40 ? 6 : null));
    expect(nights[39].debt).toBeGreaterThanOrEqual(90);
  });

  it("a sick week of long nights barely raises next month's need (the upper quartile raised it more)", () => {
    const sick = (d: number) => (d >= 20 && d < 25 ? 9.5 : null);
    const lift = (needOf: typeof personalizedNeedHours) => simulate(7.5, 0.3, sick, needOf)[30].need - simulate(7.5, 0.3, () => null, needOf)[30].need;
    const upperQuartile = (xs: number[], age: number | null) => {
      const s = xs.filter((h) => h > 0).sort((a, b) => a - b);
      if (s.length < 7) return 7.5;
      const pos = 0.75 * (s.length - 1);
      const lo = Math.floor(pos);
      return Math.min(Math.max(s[lo] + (pos - lo) * (s[Math.min(lo + 1, s.length - 1)] - s[lo]), populationNeedFloorHours(age)), 9.5);
    };
    expect(lift(personalizedNeedHours)).toBeLessThanOrEqual(0.3);
    expect(lift(upperQuartile)).toBeGreaterThan(lift(personalizedNeedHours));
  });
});

describe("SleepDebtTest", () => {
  it("on target nets to zero", () => {
    const l = ledger([["2026-06-01", 480], ["2026-06-02", 480], ["2026-06-03", 480]], 8);
    expect(l).toMatchObject({ nightCount: 3, isDebt: false, needMin: 480 });
    expect(l.balanceMin).toBeCloseTo(0, EPS);
  });

  it("debt carries at 55% and a surplus does not bank", () => {
    const l = ledger([["2026-06-01", 360], ["2026-06-02", 540], ["2026-06-03", 420]], 8);
    expect(l.balanceMin).toBeCloseTo(-33, EPS);
    expect(l.isDebt).toBe(true);
    expect(l.magnitudeMin).toBeCloseTo(33, EPS);
    expect(l.nights.map((n) => n.deltaMin)).toEqual([-120, 60, -60]);
  });

  it("skips no-data (null) nights", () => {
    const l = ledger([["2026-06-01", 480], ["2026-06-02", null], ["2026-06-04", 420]], 8);
    expect(l.nightCount).toBe(2);
    expect(l.balanceMin).toBeCloseTo(-33, EPS);
    expect(l.nights.map((n) => n.day)).toEqual(["2026-06-01", "2026-06-04"]);
  });

  it("counts a 0 as a night without sleep (SCORING_VERSION 25; noop skipped it like null)", () => {
    // 480 → 0; 0 → 0.55 × 480 = 264; 420 → 0.55 × (480 + 264 − 420) = 178.2.
    const l = ledger([["2026-06-01", 480], ["2026-06-02", null], ["2026-06-03", 0], ["2026-06-04", 420]], 8);
    expect(l.nightCount).toBe(3);
    expect(l.nights.map((n) => n.day)).toEqual(["2026-06-01", "2026-06-03", "2026-06-04"]);
    expect(l.balanceMin).toBeCloseTo(-178.2, EPS);
    expect(debtSeries([["2026-06-01", 480], ["2026-06-03", 0]], 8).at(-1)).toEqual(["2026-06-03", 264]);
  });

  it("the window cap keeps the most recent 14", () => {
    const series = Array.from({ length: 16 }, (_, i) => [`2026-06-${String(i + 1).padStart(2, "0")}`, 420] as [string, number]);
    const l = ledger(series, 8, 14);
    expect(l.nightCount).toBe(14);
    expect(l.balanceMin).toBeCloseTo(-73.3, EPS);
    expect(l.nights[0].day).toBe("2026-06-03");
    expect(l.nights.at(-1)!.day).toBe("2026-06-16");
  });

  it("empty ledger; the default need is 7.5 h (noop's 8 h case passed explicitly)", () => {
    expect(ledger([])).toMatchObject({ nightCount: 0, nights: [] });
    expect(ledger([]).balanceMin).toBeCloseTo(0, EPS);
    expect(ledger([["2026-06-01", null]]).nightCount).toBe(0);
    const l = ledger([["2026-06-01", 420]]);
    expect(l.needMin).toBe(defaultSleepNeedHours * 60);
    expect(l.balanceMin).toBeCloseTo(-0.55 * 30, EPS); // 450 − 420 = 30 short
    expect(ledger([["2026-06-01", 420]], 8).balanceMin).toBeCloseTo(-33, EPS); // noop: 0.55 × 60
  });

  it("nap minutes add repayment credit", () => {
    const credited = creditedSleepMin(392, 48)!;
    expect(credited).toBe(440);
    expect(ledger([["2026-06-01", credited]], 8).balanceMin).toBeCloseTo(-22, EPS);
    expect(creditedSleepMin(null, 48)).toBeNull();
    expect(creditedSleepMin(0, 48)).toBeNull();
    expect(creditedSleepMin(392, -10)).toBe(392);
  });

  it("debt under ten minutes clears; exactly ten remains", () => {
    expect(ledger([["2026-06-01", 480 - 9.9 / 0.55]], 8).balanceMin).toBeCloseTo(0, EPS);
    expect(ledger([["2026-06-01", 480 - 10 / 0.55]], 8).balanceMin).toBeCloseTo(-10, EPS);
  });

  it("meeting need including the current debt clears it", () => {
    const l = ledger([["2026-06-01", 360], ["2026-06-02", 546]], 8);
    expect(l.balanceMin).toBeCloseTo(0, EPS);
    expect(l.isDebt).toBe(false);
  });

  it("imported debt is verbatim but does not seed the local fallback", () => {
    const values = debtSeries([["2026-06-01", 420], ["2026-06-02", 480]], 8, new Map([["2026-06-01", 61.25]]));
    expect(values[0][1]).toBe(61.25);
    expect(round1(values[1][1])).toBeCloseTo(18.2, EPS);
  });

  it("debtSeries rounds like the ledger", () => {
    const series: [string, number][] = [["2026-06-01", 420], ["2026-06-02", 410]];
    expect(debtSeries(series, 8).at(-1)![1]).toBeCloseTo(56.7, EPS);
    expect(debtSeries(series, 8).at(-1)![1]).toBe(ledger(series, 8).magnitudeMin);
  });

  it("an imported-only gap does not consume one of the 14 usable nights", () => {
    const usable = Array.from({ length: 14 }, (_, i) => [`2026-06-${String(i + 1).padStart(2, "0")}`, 420] as [string, number | null]);
    const series = [...usable.slice(0, 13), ["2026-06-14-imported-only", null] as [string, number | null], ...usable.slice(13)];
    const values = debtSeries(series, 8, new Map([["2026-06-14-imported-only", 91.25]]));
    expect(values).toHaveLength(15);
    expect(values[13][1]).toBe(91.25);
    expect(values.at(-1)![1]).toBeCloseTo(ledger(usable, 8, 14).magnitudeMin, EPS);
  });

  it("debtSeries recomputes each day from its trailing usable window", () => {
    const series = Array.from({ length: 16 }, (_, i) => [`2026-06-${String(i + 1).padStart(2, "0")}`, 391 + i] as [string, number]);
    const values = debtSeries(series, 8, new Map(), 14);
    expect(values).toHaveLength(16);
    values.forEach(([day, debt], i) => {
      expect(day).toBe(series[i][0]);
      expect(debt).toBeCloseTo(ledger(series.slice(0, i + 1), 8, 14).magnitudeMin, EPS);
    });
  });

  it("round1 rounds half-ties away from zero", () => {
    expect(round1(-0.05)).toBeCloseTo(-0.1, EPS);
    expect(round1(0.05)).toBeCloseTo(0.1, EPS);
    expect(round1(-0.04)).toBeCloseTo(0, EPS);
    expect(round1(-0.25)).toBeCloseTo(-0.3, EPS);
  });
});

describe("sleepConsistency (1 − CV)", () => {
  it("is 1 − population CV of nightly hours, clamped, null under 3 nights", () => {
    const sd = Math.sqrt(2 / 3);
    expect(sleepConsistency([7, 8, 9])).toBeCloseTo(1 - sd / 8, 12);
    expect(sleepConsistency([8, 8, 8])).toBe(1);
    expect(sleepConsistency([8, 0, 8])).toBeNull();
    expect(sleepConsistency([1, 1, 20])).toBe(0);
  });
});

describe("a night spent awake (SCORING_VERSION 25)", () => {
  const night = { hrMinutes: 340, medianHr: 70, steps: 400 };
  const awake = (over: Partial<typeof night> = {}, restingHr: number | null = 58, sessionOverlapsNight = false) =>
    awakeAllNight({ night: { ...night, ...over }, restingHr, sessionOverlapsNight });

  it("needs the band worn, HR above resting and steps, each at its edge", () => {
    expect(allNighterConfig).toMatchObject({ nightMinutes: 360, wornMin: 300, hrAboveRest: 5, minSteps: 100 });
    expect(awake()).toBe(true);
    expect(awake({ hrMinutes: 300 })).toBe(true);
    expect(awake({ hrMinutes: 299 })).toBe(false);
    expect(awake({ medianHr: 63 })).toBe(true);
    expect(awake({ medianHr: 62.9 })).toBe(false);
    expect(awake({ steps: 100 })).toBe(true);
    expect(awake({ steps: 99 })).toBe(false);
  });

  it("any sleep session touching 00:00–06:00 rules it out, and so do missing inputs", () => {
    expect(awake({}, 58, true)).toBe(false);
    expect(awake({}, null)).toBe(false);
    expect(awake({ medianHr: null as unknown as number })).toBe(false);
    expect(awakeAllNight({ night: null, restingHr: 58, sessionOverlapsNight: false })).toBe(false);
  });

  it("nightSummary reads only the first 360 minutes: worn minutes, their median HR, and steps", () => {
    const hr = [...Array(100).fill(null), ...Array(130).fill(60), ...Array(130).fill(80), ...Array(1080).fill(150)];
    const steps = [...Array(359).fill(1), 50, ...Array(1080).fill(500)];
    expect(nightSummary(hr, steps)).toEqual({ hrMinutes: 260, medianHr: 70, steps: 409 });
    expect(nightSummary([], [])).toEqual({ hrMinutes: 0, medianHr: null, steps: 0 });
  });

  it("credits a night spent awake as 0 plus yesterday's naps; otherwise no main sleep is still no data", () => {
    expect(creditedSleepMin(null, 45, { awakeAllNight: true })).toBe(45);
    expect(creditedSleepMin(null, 0, { awakeAllNight: true })).toBe(0);
    expect(creditedSleepMin(null, 45)).toBeNull();
    expect(creditedSleepMin(0, 45)).toBeNull();
    expect(creditedSleepMin(420, 30, { awakeAllNight: true })).toBe(450);
  });

  it("debt is now monotonic in sleep: an all-nighter costs more than a 1 h night (version 24: it cost nothing)", () => {
    const after = (slept: number | null) => ledger([["2026-06-01", 450], ["2026-06-02", slept]], 7.5).magnitudeMin;
    expect(after(60)).toBeCloseTo(214.5, EPS);
    expect(after(0)).toBeCloseTo(247.5, EPS);
    expect(after(null)).toBe(0);
    const curve = Array.from({ length: 9 }, (_, h) => after(h * 60));
    for (let h = 1; h < curve.length; h++) expect(curve[h]).toBeLessThanOrEqual(curve[h - 1]);
  });
});

describe("a night without stages (SCORING_VERSION 31)", () => {
  const H = 3600;
  // The audit's night: 7 h asleep, 90 % efficiency, need 7.5 h, consistency 0.8; staged with 1 h deep and 1.6 h REM.
  const dur = (7 / 7.5) * 100;
  const staged = rest(7 * H, 0.9, 1.0 * H, 1.6 * H, 7.5, 0.8)!;

  it("restorativeScore is the same component rest() always used", () => {
    expect(restorativeScore(1.0 * H, 1.6 * H, 7 * H)).toBeCloseTo((2.6 / 7 / 0.5) * 100 * 1, 10);
    expect(staged).toBeCloseTo(Math.round((0.5 * dur + 0.2 * 90 + 0.2 * restorativeScore(H, 1.6 * H, 7 * H) + 0.1 * 80) * 100) / 100, 10);
    expect(staged).toBeCloseTo(87.5, 0);
  });

  it("with your usual restorative component it scores as that, by hand; with your own usual it matches the staged night", () => {
    expect(rest(7 * H, 0.9, null, null, 7.5, 0.8, { usualRestorative: 70 })).toBeCloseTo(Math.round((0.5 * dur + 0.2 * 90 + 0.2 * 70 + 0.1 * 80) * 100) / 100, 10);
    expect(rest(7 * H, 0.9, null, null, 7.5, 0.8, { usualRestorative: restorativeScore(H, 1.6 * H, 7 * H) })).toBeCloseTo(staged, 6);
    // Version 30 scored deep and REM as 0: about 15 points lower.
    expect(staged - rest(7 * H, 0.9, 0, 0, 7.5, 0.8)!).toBeGreaterThan(14);
  });

  it("with no usual it leaves the restorative part out and renormalises the other three", () => {
    expect(rest(7 * H, 0.9, null, null, 7.5, 0.8)).toBeCloseTo(Math.round(((0.5 * dur + 0.2 * 90 + 0.1 * 80) / 0.8) * 100) / 100, 10);
    expect(rest(7 * H, 0.9, H, null, 7.5, 0.8)).toBe(rest(7 * H, 0.9, null, null, 7.5, 0.8)); // either one missing
  });

  it("a known 0 is measured, not missing: deep 0 and REM 0 still score 0 restorative", () => {
    expect(rest(7 * H, 0.9, 0, 0, 7.5, 0.8, { usualRestorative: 70 })).toBeCloseTo(Math.round((0.5 * dur + 0.2 * 90 + 0.1 * 80) * 100) / 100, 10);
  });

  it("the usual is the median of the last 28 staged nights, from 5 of them", () => {
    expect(usualRestorativeNights).toBe(28);
    expect(minUsualRestorativeNights).toBe(5);
  });
});
