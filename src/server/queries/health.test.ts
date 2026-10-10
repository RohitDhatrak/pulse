import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db";
import { dailyMetrics, dailyScores, dailyValues, healthRecords } from "../db/schema";
import { SEED_DAYS } from "../sources/seed/scenario";
import { copyDb, ctxFor, dayAt, seeded, USER } from "../testing";
import { getFitness, getHealthspan, getMonitor, vo2maxCaption } from "./health";
import { getRecovery } from "./recovery";
import { getReport } from "./reports";
import { getSleep } from "./sleep";
import { rows, sql } from "../db";

let db: Db;
beforeAll(async () => {
  db = await seeded();
});

const today = dayAt(SEED_DAYS - 1);

describe("getMonitor heart rhythm", () => {
  it("lists the seeded ECG readings newest first, with Fitbit's labels, and counts the notification", async () => {
    const { ecg, irn } = (await getMonitor(today, ctxFor(db))).heartRhythm;
    expect(ecg.map((e) => e.label)).toEqual(["Normal sinus rhythm", "Inconclusive: high heart rate", "Normal sinus rhythm"]);
    expect(ecg.map((e) => e.tone)).toEqual(["optimal", "neutral", "optimal"]);
    expect(ecg[0].at).toBeGreaterThan(ecg[1].at);
    expect(ecg[0].avgBpm).toBe(66);
    expect(irn).toMatchObject({ count: 1, latestDay: dayAt(SEED_DAYS - 22) });
  });

  it("shows only what had happened by the selected day", async () => {
    const { ecg, irn } = (await getMonitor(dayAt(SEED_DAYS - 30), ctxFor(db))).heartRhythm;
    expect(ecg).toHaveLength(1);
    expect(irn).toEqual({ count: 0, latestAt: null, latestDay: null });
  });

  it("reads an unknown classification as no result, never as normal", async () => {
    const db2 = await copyDb(db);
    await db2.insert(healthRecords).values({ userId: USER, id: "x", kind: "ecg", ts: 1, day: today, data: { result: "SOMETHING_NEW" } });
    const x = (await getMonitor(today, ctxFor(db2))).heartRhythm.ecg.find((e) => e.id === "x")!;
    expect(x).toMatchObject({ label: "No result", tone: "neutral", avgBpm: null });
  });
});

describe("getMonitor measurements", () => {
  it("shows weight and body fat against the readings of the 30 days before, and hides metrics never recorded", async () => {
    const m = (await getMonitor(today, ctxFor(db))).measurements;
    expect(m.map((x) => x.key)).toEqual(["weight", "body_fat"]);
    const w = async (d: string) =>
      (await db.select({ w: dailyMetrics.weightKg }).from(dailyMetrics).where(and(eq(dailyMetrics.userId, USER), eq(dailyMetrics.day, d))))[0].w;
    // Monthly weigh-ins on day indexes 2, 32, ... 152: the latest is 152, compared with 122.
    expect(m[0].metric.value).toBe(await w(dayAt(152)));
    expect(m[0].average).toBe(await w(dayAt(122)));
    expect(m[0].caption).toMatch(/^\w{3}, \w{3} \d+$/);
  });

  it("adds blood glucose and core temperature once there is a value, and says no data before the first", async () => {
    const db2 = await copyDb(db);
    await db2.insert(dailyValues).values([
      { userId: USER, day: dayAt(170), key: "glucose", value: 98 },
      { userId: USER, day: dayAt(175), key: "glucose", value: 104 },
      { userId: USER, day: dayAt(176), key: "core_temp", value: 36.8 },
    ]);
    const m = (await getMonitor(today, ctxFor(db2))).measurements;
    expect(m.map((x) => x.key)).toEqual(["weight", "body_fat", "glucose", "core_temp"]);
    expect(m[2]).toMatchObject({ metric: { value: 104 }, average: 98, unit: "mg/dL" });
    expect(m[3].average).toBeNull();
    const before = (await getMonitor(dayAt(160), ctxFor(db2))).measurements[2];
    expect(before.metric).toMatchObject({ value: null, reason: "no_data" });
  });
});

describe("the sleeping heart rate and the overnight curves (SCORING_VERSION 35)", () => {
  const metricsOn = async (day: string) => (await db.select().from(dailyMetrics).where(and(eq(dailyMetrics.userId, USER), eq(dailyMetrics.day, day))))[0];

  it("once its baseline is trusted, the Monitor and Recovery show the sleeping heart rate, its trend that series alone", async () => {
    const d = dayAt(150);
    const m = await metricsOn(d);
    const vm = await getMonitor(d, ctxFor(db));
    const rhr = vm.vitals.find((v) => v.key === "restingHr")!;
    expect(rhr).toMatchObject({ label: "Sleeping heart rate", metric: { value: m.nonRemHrBpm } });
    // The 30-night trend is non-REM heart rates only: never a mix with Google's daily value.
    const trendDays = rhr.trend.points.filter((p) => p.value !== null);
    for (const p of trendDays.slice(-5)) expect(p.value).toBe((await metricsOn(p.day)).nonRemHrBpm);
    const rec = (await getRecovery(d, ctxFor(db))).contributors.find((c) => c.key === "rhr")!;
    expect(rec).toMatchObject({ label: "Sleeping heart rate", metric: { value: m.nonRemHrBpm } });
    // Early on, before that baseline is trusted, Google's daily value under its usual name.
    const early = (await getMonitor(dayAt(8), ctxFor(db))).vitals.find((v) => v.key === "restingHr")!;
    expect(early).toMatchObject({ label: "Resting heart rate", metric: { value: (await metricsOn(dayAt(8))).rhrBpm } });
  });

  it("the HRV and SpO2 sheets carry last night's curve, the same as Sleep's; the others carry none", async () => {
    const d = dayAt(150);
    const vm = await getMonitor(d, ctxFor(db));
    const sleep = await getSleep(d, ctxFor(db));
    expect(vm.vitals.find((v) => v.key === "hrv")!.night).toEqual(sleep.nightHrv);
    expect(vm.vitals.find((v) => v.key === "spo2")!.night).toEqual(sleep.nightSpo2);
    expect(vm.vitals.filter((v) => v.night !== undefined).map((v) => v.key)).toEqual(["spo2", "hrv"]);
    expect((await getMonitor(dayAt(156), ctxFor(db))).vitals.find((v) => v.key === "hrv")!.night).toMatchObject({ value: null });
  });
});

describe("getHealthspan (SCORING_VERSION 19)", () => {
  it("vo2maxCaption: daily half weight, runs only, or a blend with the run count", () => {
    expect(vo2maxCaption("daily", 0)).toBe("Estimated: counts half");
    expect(vo2maxCaption("run", 1)).toBe("From 1 run");
    expect(vo2maxCaption("blend", 12)).toBe("From 12 runs and daily estimates");
  });

  it("on the seed: VO2max is a blend of the weekly runs and daily estimates; strength is logged", async () => {
    const vm = await getHealthspan(today, ctxFor(db));
    expect(vm.result.value).not.toBeNull();
    const vo2 = vm.contributors.find((c) => c.key === "vo2max")!;
    expect(vo2.caption).toMatch(/^From \d+ runs and daily estimates$/);
    // Logged, so not "Not logged"; under 24 logs since version 29 it names the count (next describe).
    expect(vm.contributors.find((c) => c.key === "strength")!.caption).not.toMatch(/^Not logged/);
  });

  it("strength never logged reads 'Not logged', not as a shortfall", async () => {
    const copy = await copyDb(db);
    const shown = (await getHealthspan(today, ctxFor(copy))).asOf;
    const [row] = await copy.select({ h: dailyScores.healthspan }).from(dailyScores).where(and(eq(dailyScores.userId, USER), eq(dailyScores.day, shown)));
    const h = row.h as { contributions: { key: string; years: number; unlogged?: boolean; value: number }[] };
    const s = h.contributions.find((c) => c.key === "strength")!;
    Object.assign(s, { unlogged: true, years: 0, value: 0 });
    await copy.update(dailyScores).set({ healthspan: h }).where(and(eq(dailyScores.userId, USER), eq(dailyScores.day, shown)));
    const c = (await getHealthspan(today, ctxFor(copy))).contributors.find((x) => x.key === "strength")!;
    expect(c.caption).toBe("Not logged: log strength workouts in Fitbit to count them.");
    expect(c.years).toBe(0);
  });

  it("in the first two weeks it is calibrating, counting down the activity days left", async () => {
    const vm = await getHealthspan(dayAt(3), ctxFor(db));
    const [row] = await db.select({ h: dailyScores.healthspan }).from(dailyScores).where(and(eq(dailyScores.userId, USER), eq(dailyScores.day, vm.asOf)));
    const h = row.h as { reason: string; activityDays: number };
    expect(h.reason).toBe("calibrating");
    expect(vm.result).toMatchObject({ value: null, reason: "calibrating", nightsLeft: Math.max(1, 14 - h.activityDays) });
  });
});

describe("a light training load (SCORING_VERSION 27)", () => {
  it("the Fitness training-load metric says 'light load', not 'calibrating', when the day has no ratio for that reason", async () => {
    expect((await getFitness(ctxFor(db))).trainingLoad.value).not.toBeNull(); // the seed's chronic load is 44–155 a day
    const db2 = await copyDb(db);
    await db2.execute(sql`update daily_scores set training_load = training_load || '{"acwr": null, "lightLoad": true}'::jsonb where user_id = ${USER} and day = ${today}`);
    expect((await getFitness(ctxFor(db2))).trainingLoad).toMatchObject({ value: null, reason: "light_load" });
  });

  it("a report that ends on a light load shows 'light load' for its training balance", async () => {
    const [{ period }] = await rows<{ period: string }>(db, sql`select period from reports where user_id = ${USER} order by period desc limit 1`);
    const db2 = await copyDb(db);
    await db2.execute(sql`update reports set data = data || '{"trainingBalance": null, "lightLoad": true}'::jsonb where user_id = ${USER} and period = ${period}`);
    expect((await getReport(period, ctxFor(db2)))!.trainingBalance).toMatchObject({ value: null, reason: "light_load" });
  });
});

describe("Pace's activity days (SCORING_VERSION 28)", () => {
  it("the Healthspan view model carries how many of the last 30 days had activity data", async () => {
    const r = (await getHealthspan(today, ctxFor(db))).result.value!;
    expect(r.paceActivityDays).toBeGreaterThanOrEqual(14);
    expect(r.paceActivityDays).toBeLessThanOrEqual(30);
  });
});

describe("the strength caption (SCORING_VERSION 29)", () => {
  it("names how many strength workouts are logged while that's under 24, since the term counts in proportion", async () => {
    const vm = await getHealthspan(today, ctxFor(db));
    const [row] = await db.select({ h: dailyScores.healthspan }).from(dailyScores).where(and(eq(dailyScores.userId, USER), eq(dailyScores.day, vm.asOf)));
    const logs = (row.h as { strengthLogs: number }).strengthLogs;
    expect(logs).toBeGreaterThan(0);
    expect(logs).toBeLessThan(24); // the seed logs about one a week
    expect(vm.contributors.find((x) => x.key === "strength")!.caption).toBe(`Based on ${logs} logged strength workouts in 6 months: it counts more fully as you log more.`);
  });
});
