// "Count my data from" on the read side (SCORING_VERSION 34): with a date, nothing before it is shown; raw device
// tables are read from it, and the scores before it are gone once the pipeline has run with it. Journal entries, the
// person's own words, stay visible.
import { beforeAll, describe, expect, it } from "vitest";
import { type Db, rows, sql } from "../db";
import { recompute } from "../pipeline";
import { copyDb, ctxFor, dayAt, OPTS, seeded, USER } from "../testing";
import { addDays, localMidnight } from "../time";
import { getActivities } from "./activities";
import { getActivity } from "./activity";
import { deviceSwitchFor, exercisesBetween, loadDays, type QueryCtx } from "./common";
import { getCalendarMonth } from "./calendar";
import { getFitness, getHealthHub, getHealthspan, getHeartRate, getMonitor, getStress } from "./health";
import { getHome } from "./home";
import { getJournal, getJournalInsights } from "./journal";
import { DETAIL_KEYS, getMetricDetail } from "./metric";
import { getRecovery } from "./recovery";
import { getReportArchive } from "./reports";
import { getSettings } from "./settings";
import { getSleep } from "./sleep";
import { getStrain } from "./strain";
import { getTrends, TREND_METRICS } from "./trends";

const FROM = dayAt(170);
let db: Db;
let ctx: QueryCtx;
beforeAll(async () => {
  db = await copyDb(await seeded());
  await recompute(db, { ...OPTS, dataFrom: FROM });
  const base = ctxFor(db);
  ctx = { ...base, profile: { ...base.profile, dataFrom: FROM } };
});

describe("count my data from on the screens (version 34)", () => {
  it("loadDays and exercisesBetween return nothing before the date", async () => {
    const days = await loadDays(ctx, dayAt(150), dayAt(179));
    // Every day in the range is still there (callers index any day), just empty before the date.
    expect([...days.keys()]).toEqual(Array.from({ length: 30 }, (_, i) => dayAt(150 + i)));
    for (const [day, row] of days) {
      if (day < FROM) expect(row.recovery ?? row.metrics ?? row.sleep ?? null, day).toBeNull();
    }
    expect((await loadDays(ctx, dayAt(150), dayAt(179))).get(FROM)?.metrics).toBeTruthy();
    expect((await exercisesBetween(ctx, dayAt(100), dayAt(179))).every((e) => e.day >= FROM)).toBe(true);
    expect((await exercisesBetween(ctxFor(db), dayAt(100), dayAt(179))).some((e) => e.day < FROM)).toBe(true); // stored
  });

  it("an activity from before the date doesn't open, and the list has nothing older to page to", async () => {
    const [old] = await rows<{ id: string }>(db, sql`select id from exercises where user_id = ${USER} and day < ${FROM} order by day desc limit 1`);
    expect(await getActivity(old.id, ctx)).toBeNull();
    expect(await getActivity(old.id, ctxFor(db))).not.toBeNull();
    const list = await getActivities(30, ctx);
    expect(JSON.stringify(list)).not.toContain(old.id);
  });

  it("every screen renders with the date set, on days before, at and after it", async () => {
    for (const d of [dayAt(160), FROM, dayAt(179)]) {
      for (const f of [getHome, getRecovery, getStrain, getSleep, getMonitor, getStress, getHealthspan, getJournal, getHeartRate]) await f(d, ctx);
      for (const key of DETAIL_KEYS) await getMetricDetail(key, d, ctx);
    }
    for (const m of TREND_METRICS) {
      const t = await getTrends(m.key, ctx);
      if (t.points.value) expect(t.points.value.filter((p) => p.day < FROM && p.value !== null), m.key).toEqual([]);
    }
    for (const m of ["recovery", "hrv", "sleep"] as const) await getJournalInsights(m, ctx);
    await Promise.all([getHealthHub(ctx), getFitness(ctx), getCalendarMonth(dayAt(160).slice(0, 7), ctx), getReportArchive(ctx), getSettings(ctx)]);
  });

  it("heart-rate minutes before the date are gaps", async () => {
    const cut = localMidnight(FROM, ctx.timeZone) * 1000;
    const before = (c: QueryCtx) => getHeartRate(addDays(FROM, -1), c).then((hr) => hr.points.filter((p) => p.t < cut && p.v != null));
    expect((await before(ctxFor(db))).length).toBeGreaterThan(100); // the day before has heart rate stored
    expect(await before(ctx)).toHaveLength(0);
  });
});

describe("the device-switch suggestion (version 34)", () => {
  it("offers the first night of the new source, hides once the date covers it, and stays hidden when dismissed", async () => {
    const copy = await copyDb(await seeded());
    await copy.execute(sql`update sleep_sessions set source = case when day < ${dayAt(170)} then 'HEALTH_CONNECT' else 'FITBIT' end where user_id = ${USER} and is_main`);
    const c = ctxFor(copy);
    expect(await deviceSwitchFor(c)).toEqual({ day: dayAt(170), from: "HEALTH_CONNECT", to: "FITBIT" });
    expect(await deviceSwitchFor({ ...c, profile: { ...c.profile, dataFrom: dayAt(170) } })).toBeNull();
    expect(await deviceSwitchFor({ ...c, profile: { ...c.profile, dataFrom: dayAt(100) } })).not.toBeNull(); // an older date still leaves the old device in
    expect(await deviceSwitchFor({ ...c, profile: { ...c.profile, deviceSwitchDismissed: dayAt(170) } })).toBeNull();
    expect(await deviceSwitchFor(ctxFor(await seeded()))).toBeNull(); // one source throughout
  });
});
