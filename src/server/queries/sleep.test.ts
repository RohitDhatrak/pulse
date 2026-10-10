import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db";
import { mergeSamples, readTenths, writeSamples } from "../samples";
import { copyDb, ctxFor, dayAt, seeded, USER } from "../testing";
import { getSleep, UNSTAGED_OMITTED, UNSTAGED_USUAL } from "./sleep";
import { sql } from "../db";

let db: Db;
beforeAll(async () => {
  db = await seeded();
});

describe("getSleep", () => {
  it("a normal night has performance, stages that sum to 100%, a need breakdown and ordered bedtimes", async () => {
    const vm = await getSleep(dayAt(150), ctxFor(db));
    expect(vm.performance.value).toBeGreaterThan(40);
    expect(vm.performance.value).toBeLessThanOrEqual(100);
    const stages = vm.stages!.value!;
    expect(stages.rows.map((r) => r.label)).toEqual(["Awake", "REM", "Light", "Deep"]);
    expect(stages.rows.reduce((a, r) => a + r.pct, 0)).toBeCloseTo(100, 6);
    expect(stages.segments.length).toBeGreaterThan(5);
    expect(stages.bed).toBeLessThan(stages.wake);
    const need = vm.hoursVsNeed.value!;
    expect(need.calibrating).toBe(false);
    expect(need.needMin).toBeCloseTo(need.parts.baselineMin + need.parts.strainMin + need.parts.debtMin - need.parts.napMin, 6);
    expect(vm.summary.map((s) => s.label)).toEqual(["Hours vs. needed", "Sleep consistency", "Sleep efficiency", "Restorative sleep"]);
    expect(vm.summary.every((s) => s.status)).toBe(true);
    const consistency = vm.summary[1].metric.value!;
    expect(consistency).toBeGreaterThan(50);
    expect(consistency).toBeLessThanOrEqual(100);
    const plans = vm.planner.value!.plans;
    expect(plans[0].bedtimeAt).toBeLessThan(plans[1].bedtimeAt);
    expect(plans[1].bedtimeAt).toBeLessThan(plans[2].bedtimeAt);
    expect(vm.insight).toMatch(/^Your sleep was (optimal|sufficient|poor)\./);
    expect(vm.debtTrend.points).toHaveLength(182);
  });

  it("calibrates the need and the planner in the first week", async () => {
    const vm = await getSleep(dayAt(3), ctxFor(db));
    expect(vm.hoursVsNeed.value?.calibrating).toBe(true);
    expect(vm.hoursVsNeed.value?.needMin).toBe(450); // 7.5 h before 7 nights (SCORING_VERSION 15; was 8 h)
    expect(vm.planner).toMatchObject({ value: null, reason: "calibrating", nightsLeft: 3 });
  });

  it("band-off nights read 'band not worn'; today before wake reads 'awaiting sleep sync'", async () => {
    const off = await getSleep(dayAt(156), ctxFor(db));
    expect(off.performance.reason).toBe("band_not_worn");
    expect(off.stages).toMatchObject({ value: null, reason: "band_not_worn" });
    expect(off.hoursVsNeed.reason).toBe("band_not_worn");

    const before = Date.parse("2026-10-02T05:00:00+05:30") / 1000;
    const morning = await getSleep(dayAt(179), ctxFor(await seeded([before]), before));
    expect(morning.performance.reason).toBe("awaiting_sleep_sync");
    expect(morning.stages).toMatchObject({ value: null, reason: "awaiting_sleep_sync" });
  });

  it("the hours hero is the main sleep's time asleep against the prior 30 nights", async () => {
    const vm = await getSleep(dayAt(150), ctxFor(db));
    const h = vm.hours.value!;
    expect(h.asleepMin).toBe(vm.hoursVsNeed.value!.asleepMin);
    const prior = (await Promise.all(Array.from({ length: 30 }, async (_, k) => (await getSleep(dayAt(149 - k), ctxFor(db))).hours.value?.asleepMin))).filter((x): x is number => x != null);
    expect(h.average).toBeCloseTo(prior.reduce((a, b) => a + b, 0) / prior.length, 6);
    expect(h.sd).toBeGreaterThan(0);
    // The first night has nothing to compare with.
    expect((await getSleep(dayAt(0), ctxFor(db))).hours.value?.average ?? null).toBeNull();
  });

  it("the overnight HR is per minute over the sleep window plus 15 minutes each side", async () => {
    const vm = await getSleep(dayAt(150), ctxFor(db));
    const { bed, wake, points } = vm.nightHr.value!;
    const stages = vm.stages!.value!;
    expect([bed, wake]).toEqual([stages.bed, stages.wake]);
    expect(points[0].t).toBeLessThanOrEqual(bed - 15 * 60_000);
    expect(points[0].t).toBeGreaterThan(bed - 16 * 60_000);
    expect(points.at(-1)!.t).toBeLessThan(wake + 15 * 60_000);
    expect(points.every((p, i) => i === 0 || p.t - points[i - 1].t === 60_000)).toBe(true);
    const inNight = points.filter((p) => p.t >= bed && p.t < wake && p.v !== null).map((p) => p.v!);
    expect(inNight.length).toBeGreaterThan((wake - bed) / 60_000 / 2);
    expect(Math.min(...inNight)).toBeGreaterThan(30);
    expect(Math.max(...inNight)).toBeLessThan(140);
  });

  it("no sleep: the hero and the HR chart carry the night's reason", async () => {
    const off = await getSleep(dayAt(156), ctxFor(db));
    expect(off.hours).toMatchObject({ value: null, reason: "band_not_worn" });
    expect(off.nightHr).toMatchObject({ value: null, reason: "band_not_worn" });
    const before = Date.parse("2026-10-02T05:00:00+05:30") / 1000;
    const morning = await getSleep(dayAt(179), ctxFor(await seeded([before]), before));
    expect(morning.hours.reason).toBe("awaiting_sleep_sync");
    expect(morning.nightHr.reason).toBe("awaiting_sleep_sync");
  });

  it("a night with HR samples wiped reads 'not enough heart-rate data'", async () => {
    const copy = await copyDb(db);
    const { bed, wake } = (await getSleep(dayAt(150), ctxFor(copy))).nightHr.value!;
    await mergeSamples(copy, "hr", USER, { start: bed / 1000, end: wake / 1000 }, new Map(), "replace");
    expect((await getSleep(dayAt(150), ctxFor(copy))).nightHr).toMatchObject({ value: null, reason: "insufficient_hr_data" });
  });

  describe("overnight HRV and SpO2, and Disturbances (version 35)", () => {
    it("each curve is the main sleep's samples only, with low, high and median taken from them", async () => {
      const vm = await getSleep(dayAt(150), ctxFor(db));
      const { bed, wake } = vm.stages!.value!;
      for (const [kind, m] of [["hrv", vm.nightHrv], ["spo2", vm.nightSpo2]] as const) {
        const n = m.value!;
        expect([n.bed, n.wake]).toEqual([bed, wake]);
        const vs = n.points.filter((p) => p.v !== null).map((p) => p.v!);
        expect(n.points.every((p) => p.t >= bed && p.t <= wake)).toBe(true);
        const stored = await readTenths(db, kind, USER, bed / 1000, wake / 1000 + 1);
        expect(vs).toEqual(stored.map((x) => x.v));
        expect(n.low.v).toBe(Math.min(...vs));
        expect(n.high.v).toBe(Math.max(...vs));
        const sorted = [...vs].sort((a, b) => a - b);
        const mid = sorted.length >> 1;
        expect(n.median).toBeCloseTo(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, 9);
      }
      // HRV about every 5 minutes, SpO2 about every minute, across the night.
      expect(vm.nightHrv.value!.points.length).toBeGreaterThan((wake - bed) / 300_000 / 2);
      expect(vm.nightSpo2.value!.points.length).toBeGreaterThan((wake - bed) / 60_000 / 2);
    });

    it("a daytime spot check stays off the night's curve; a hole in the samples is a gap; too few samples is no curve", async () => {
      const copy = await copyDb(db);
      const night = (await getSleep(dayAt(150), ctxFor(copy))).nightSpo2.value!;
      await writeSamples(copy, "spo2", USER, [{ ts: night.wake / 1000 + 6 * 3600, v: 881 }]);
      // An hour without HRV in the middle of the night.
      const mid = (night.bed + night.wake) / 2000;
      await mergeSamples(copy, "hrv", USER, { start: mid, end: mid + 3600 }, new Map(), "replace");
      const vm = await getSleep(dayAt(150), ctxFor(copy));
      expect(vm.nightSpo2.value!.points.some((p) => p.v === 88.1)).toBe(false);
      const gaps = vm.nightHrv.value!.points.filter((p) => p.v === null);
      expect(gaps).toHaveLength(1);
      expect(gaps[0].t).toBeGreaterThan(mid * 1000);
      // Five samples left is too thin to draw.
      const all = await readTenths(copy, "spo2", USER, night.bed / 1000, night.wake / 1000 + 1);
      await mergeSamples(copy, "spo2", USER, { start: night.bed / 1000, end: night.wake / 1000 + 1 }, new Map(all.slice(0, 5).map((x) => [x.ts, x.v * 10])), "replace");
      expect((await getSleep(dayAt(150), ctxFor(copy))).nightSpo2).toMatchObject({ value: null, reason: "no_data" });
      // No night: the curves carry the night's reason.
      expect((await getSleep(dayAt(156), ctxFor(db))).nightHrv).toMatchObject({ value: null, reason: "band_not_worn" });
    });

    it("Disturbances: the night's brief awakenings against the prior 30 nights, marked on the hypnogram", async () => {
      const vm = await getSleep(dayAt(150), ctxFor(db));
      const row = vm.details.find((d) => d.key === "disturbances")!;
      expect(row).toMatchObject({ label: "Disturbances", direction: "down" });
      const marks = vm.stages!.value!.awakenings;
      expect(row.metric.value).toBe(marks.length);
      expect(marks.length).toBeGreaterThanOrEqual(6);
      expect(marks.every((a) => (a.stage === "light" || a.stage === "rem") && a.end > a.start)).toBe(true);
      expect(row.average).toBeGreaterThan(5);
      expect(vm.details.map((d) => d.key)).toEqual(["timeInBed", "wakeEvents", "disturbances", "resp", "debt"]);
    });
  });

  it("the short-sleep streak builds sleep debt", async () => {
    const debt = async (i: number) => (await getSleep(dayAt(i), ctxFor(db))).details.find((s) => s.key === "debt")!.metric.value!;
    expect(await debt(172)).toBeGreaterThan((await debt(167)) + 60);
  });
});

describe("the note for a night without stages (SCORING_VERSION 31)", () => {
  it("is empty on a staged night, and says how an unstaged night was scored", async () => {
    const day = dayAt(100);
    expect((await getSleep(day, ctxFor(db))).performanceNote).toBeNull();
    const db2 = await copyDb(db);
    const set = (v: string) => db2.execute(sql`update daily_scores set sleep = sleep || ${JSON.stringify({ restorative: v })}::jsonb where user_id = ${USER} and day = ${day}`);
    await set("usual");
    expect((await getSleep(day, ctxFor(db2))).performanceNote).toBe(UNSTAGED_USUAL);
    await set("omitted");
    expect((await getSleep(day, ctxFor(db2))).performanceNote).toBe(UNSTAGED_OMITTED);
  });
});
