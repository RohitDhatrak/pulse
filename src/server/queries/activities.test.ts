// The /activities journal: day groups newest first, today always present, and "Show older".
import { beforeAll, describe, expect, it } from "vitest";
import { type Db, row, sql } from "../db";
import { copyDb, ctxFor, seeded, USER } from "../testing";
import { addDays } from "../time";
import { getActivities } from "./activities";
import { getActivity } from "./activity";
import { getStrain } from "./strain";

let db: Db;
beforeAll(async () => {
  db = await seeded();
});

describe("getActivities", () => {
  it("groups the window's workouts by day, newest first, with today leading", async () => {
    const vm = await getActivities(30, ctxFor(db));
    const days = vm.groups.map((g) => g.day);
    expect(days[0]).toBe(vm.today);
    expect([...days].sort().reverse()).toEqual(days);
    const { n } = (await row<{ n: number }>(db, sql`select count(*) n from exercises where user_id = ${USER} and day > ${addDays(vm.today, -30)}`))!;
    expect(vm.groups.reduce((a, g) => a + g.items.length, 0)).toBe(n);
    for (const g of vm.groups) for (const a of g.items) expect(a.day).toBe(g.day);
    expect(vm.older).toBe(true);
  });

  it("has nothing older once the window covers every workout", async () => {
    expect((await getActivities(3650, ctxFor(db))).older).toBe(false);
  });
});

describe("one workout per session (SCORING_VERSION 51)", () => {
  it("an app's Health Connect copy of a session is not listed, not counted as strength again, and its link opens the session", async () => {
    const copy = await copyDb(db);
    const w = (await row<{ id: string; day: string; s: number; e: number }>(
      copy,
      sql`select id, day::text as day, start_ts s, end_ts e from exercises where user_id = ${USER} and type = 'STRENGTH_TRAINING' order by start_ts desc limit 1`,
    ))!;
    const before = await Promise.all([getActivities(60, ctxFor(copy)), getStrain(w.day, ctxFor(copy))]);
    await copy.execute(
      sql`insert into exercises (user_id, id, day, start_ts, end_ts, type, name, calories, source) values (${USER}, 'hc-copy', ${w.day}, ${Number(w.s) - 40}, ${Number(w.e) + 20}, 'STRENGTH_TRAINING', 'Strength training', null, 'HEALTH_CONNECT')`,
    );
    const [list, strain] = await Promise.all([getActivities(60, ctxFor(copy)), getStrain(w.day, ctxFor(copy))]);
    const items = list.groups.find((g) => g.day === w.day)!.items;
    expect(items.map((a) => a.id)).toEqual(before[0].groups.find((g) => g.day === w.day)!.items.map((a) => a.id));
    expect(items.map((a) => a.id)).not.toContain("hc-copy");
    const strength = (vm: typeof strain) => vm.summary.find((k) => k.key === "strength")!.metric.value;
    expect(strength(strain)).toBe(strength(before[1]));
    expect((await getActivity("hc-copy", ctxFor(copy)))?.id).toBe(w.id);
  });
});
