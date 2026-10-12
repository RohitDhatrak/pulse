// Strain's activity extras and the distance on activities (spec §11 EX1, EX3).
import { beforeAll, describe, expect, it } from "vitest";
import { type Db, row, rows, sql } from "../db";
import { ctxFor, dayAt, seeded, USER } from "../testing";
import { getActivity } from "./activity";
import { activityItem, distanceOf, type ExerciseRow } from "./common";
import { getStrain, STRAIN_EXTRAS } from "./strain";

let db: Db;
beforeAll(async () => {
  db = await seeded();
});

const one = async <T>(q: ReturnType<typeof sql>) => Object.values((await row<Record<string, T>>(db, q))!)[0];
const caloriesOn = (d: string) => one<number>(sql`select calories from daily_metrics where user_id = ${USER} and day = ${d}`);
const valueOn = (d: string, key: string) => one<number>(sql`select value from daily_values where user_id = ${USER} and day = ${d} and key = ${key}`);

describe("getStrain summary", () => {
  it("lists the extras after Steps with the catalogue's unit, format and direction, and a 30-day average", async () => {
    const vm = await getStrain(dayAt(178), ctxFor(db));
    expect(vm.summary.map((k) => k.key)).toEqual(["zones13", "zones45", "strength", "steps", ...STRAIN_EXTRAS]);
    const distance = vm.summary.find((k) => k.key === "distance")!;
    expect(distance).toMatchObject({ label: "Distance", unit: "km", format: "decimal2", direction: "up" });
    expect(distance.metric.value).toBeGreaterThan(0);
    expect(distance.average).toBeGreaterThan(0);
    const avg = await one<number>(sql`select avg(value) from daily_values where user_id = ${USER} and key = 'azm' and day >= ${dayAt(148)} and day <= ${dayAt(177)}`);
    expect(vm.summary.find((k) => k.key === "azm")!.average).toBeCloseTo(avg, 6);
    expect(vm.summary.find((k) => k.key === "active_calories")!.direction).toBe("neutral");
  });

  it("is honest without a value: band_not_worn on the band-off day, no_data on a worn day the account has none", async () => {
    const off = (await getStrain(dayAt(156), ctxFor(db))).summary.find((k) => k.key === "floors")!;
    expect(off.metric).toMatchObject({ value: null, reason: "band_not_worn" });
    await db.execute(sql`delete from daily_values where user_id = ${USER} and day = ${dayAt(170)} and key = 'floors'`);
    const missing = (await getStrain(dayAt(170), ctxFor(db))).summary.find((k) => k.key === "floors")!;
    expect(missing.metric).toMatchObject({ value: null, reason: "no_data" });
  });
});

describe("getStrain calories and workouts", () => {
  it("splits each day's total into active and resting, with today faded as a running total", async () => {
    const ctx = ctxFor(db);
    const today = await getStrain(dayAt(179), ctx);
    expect(today.isToday).toBe(true);
    expect(today.calories).toHaveLength(30);
    const last = today.calories.at(-1)!;
    expect(last).toMatchObject({ day: dayAt(179), provisional: true });
    const total = await caloriesOn(dayAt(178));
    const active = await valueOn(dayAt(178), "active_calories");
    const past = (await getStrain(dayAt(178), ctx)).calories.at(-1)!;
    expect(past).toEqual({ day: dayAt(178), value: total, parts: { active, resting: total - active } });
  });

  it("says no breakdown when active is missing and never puts resting below 0", async () => {
    const ctx = ctxFor(db);
    await db.execute(sql`delete from daily_values where user_id = ${USER} and day = ${dayAt(175)} and key = 'active_calories'`);
    await db.execute(sql`update daily_values set value = 99999 where user_id = ${USER} and day = ${dayAt(174)} and key = 'active_calories'`);
    const pts = (await getStrain(dayAt(176), ctx)).calories;
    expect(pts.find((p) => p.day === dayAt(175))).toEqual({ day: dayAt(175), value: await caloriesOn(dayAt(175)), parts: null });
    expect(pts.find((p) => p.day === dayAt(174))!.parts).toEqual({ active: await caloriesOn(dayAt(174)), resting: 0 });
  });

  it("sums workout minutes per day, 0 on a day with data and none", async () => {
    const ctx = ctxFor(db);
    const pts = (await getStrain(dayAt(178), ctx)).workouts.points;
    expect(pts).toHaveLength(60);
    const minutes = await rows<{ day: string; m: number }>(
      db,
      sql`select day::text, (sum(end_ts - start_ts) / 60.0)::float8 m from exercises where user_id = ${USER} and day >= ${dayAt(119)} and day <= ${dayAt(178)} group by day`,
    );
    expect(minutes.length).toBeGreaterThan(0);
    for (const { day, m } of minutes) expect(pts.find((p) => p.day === day)!.value).toBeCloseTo(m, 6);
    const rest = pts.find((p) => !minutes.some((x) => x.day === p.day))!;
    expect(rest.value).toBe(0);
  });
});

describe("activity distance", () => {
  const ex = (type: string, distanceM: number | null): ExerciseRow => ({ id: "x", day: dayAt(1), startTs: 0, endTs: 30 * 60, type, name: null, calories: null, distanceM });

  it("gives km for any recorded distance, pace only for runs and walks, nothing for none or zero", async () => {
    expect(distanceOf(ex("RUNNING", 6000))).toEqual({ distanceKm: 6, paceS: 300 });
    expect(distanceOf(ex("WALKING", 2500))).toEqual({ distanceKm: 2.5, paceS: 720 });
    expect(distanceOf(ex("BIKING", 15000))).toEqual({ distanceKm: 15, paceS: null });
    expect(distanceOf(ex("STRENGTH_TRAINING", null))).toEqual({ distanceKm: null, paceS: null });
    expect(distanceOf(ex("RUNNING", 0))).toEqual({ distanceKm: null, paceS: null });
    expect(activityItem(ex("RUNNING", 6000), undefined)).toMatchObject({ distanceKm: 6, paceS: 300 });
  });

  it("the activity screen adds Distance and Pace for a run, Distance for a ride, neither for strength", async () => {
    const ctx = ctxFor(db);
    const first = (type: string) => one<string>(sql`select id from exercises where user_id = ${USER} and type = ${type} order by start_ts desc limit 1`);
    const keys = async (type: string) => (await getActivity(await first(type), ctx))!.stats.map((k) => k.key);
    expect(await keys("RUNNING")).toEqual(["duration", "distance", "pace", "avgHr", "maxHr", "calories"]);
    expect(await keys("BIKING")).toEqual(["duration", "distance", "avgHr", "maxHr", "calories"]);
    expect(await keys("STRENGTH_TRAINING")).toEqual(["duration", "avgHr", "maxHr", "calories"]);
    const run = (await getActivity(await first("RUNNING"), ctx))!.stats;
    expect(run.find((k) => k.key === "pace")).toMatchObject({ unit: "/km", format: "pace" });
    expect(run.find((k) => k.key === "pace")!.metric.value).toBeGreaterThan(180);
    expect(run.find((k) => k.key === "pace")!.average).not.toBeNull();
  });
});

describe("getStrain's target (SCORING_VERSION 48)", () => {
  it("a starter target shows as an estimate; the person's own established target does not", async () => {
    const day = dayAt(170);
    const own = (await getStrain(day, ctxFor(db))).target.value!;
    expect(own.estimate).toBe(false);
    await db.execute(sql`update daily_scores set strain_target = strain_target || '{"starter": true}'::jsonb where user_id = ${USER} and day = ${day}`);
    expect((await getStrain(day, ctxFor(db))).target.value).toMatchObject({ low: own.low, high: own.high, estimate: true });
    // A row stored before version 48 has no `starter`: still its own coldStart.
    await db.execute(sql`update daily_scores set strain_target = strain_target - 'starter' where user_id = ${USER} and day = ${day}`);
    expect((await getStrain(day, ctxFor(db))).target.value!.estimate).toBe(false);
  });
});
