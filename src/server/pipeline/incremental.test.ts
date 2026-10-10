// The pipeline tests that seed their own databases, apart from pipeline.test.ts so the two files run in parallel.
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { type Db, rows, sql } from "../db";
import { dailyMetrics, sleepAwakenings, sleepSegments, sleepSessions } from "../db/schema";
import { lastRun, recompute, type RecoveryRow } from ".";
import { seedPull } from "../sources/seed/generate";
import { localMidnight } from "../time";
import { copyDb, DAY_S, dayAt, dump, NOW, OPTS, PROFILE, seeded, TZ, USER } from "../testing";

const recovery = async (db: Db, day: string) =>
  (await rows<{ v: RecoveryRow }>(db, sql`select recovery v from daily_scores where user_id = ${USER} and day = ${day}`))[0].v;

describe("recovery updates", () => {
  it("a score that gains a term later is flagged Updated", async () => {
    // Today's skin temperature lands 90 minutes after the rest of the night.
    const early = await seeded([Date.parse("2026-10-02T08:00:00+05:30") / 1000]);
    const before = await recovery(early, dayAt(179));
    expect(before.value).toBeTypeOf("number");
    expect(before.terms).not.toContain("skinTemp");
    await seedPull(early, { userId: USER, now: Date.parse("2026-10-02T10:00:00+05:30") / 1000, timeZone: TZ, maxHr: PROFILE.maxHr });
    await recompute(early, OPTS);
    const after = await recovery(early, dayAt(179));
    expect(after.terms).toContain("skinTemp");
    expect(after.updated).toBe(true);
    expect((await recovery(early, dayAt(178))).updated).toBe(false);
  });
});

describe("incremental equals full on 220 days", () => {
  it("a late night for day 200 then an incremental recompute matches a from-scratch recompute byte for byte", async () => {
    const base = await seeded([NOW - 40 * DAY_S, NOW], { compute: false });
    const metricDays = await base.select({ day: dailyMetrics.day }).from(dailyMetrics).where(eq(dailyMetrics.userId, USER)).orderBy(dailyMetrics.day);
    expect(metricDays).toHaveLength(220);
    const full = await copyDb(base);
    const late = await copyDb(base);
    const first = metricDays[0].day;
    const at = (i: number) => new Date(Date.parse(first) + i * DAY_S * 1000).toISOString().slice(0, 10);
    const day = at(200);

    // Hold back night 200: its session, stages, brief awakenings and nightly metrics.
    const s = sleepSessions;
    const [session] = await late.select().from(s).where(and(eq(s.userId, USER), eq(s.day, day), eq(s.isMain, true)));
    const segments = await late.select().from(sleepSegments).where(and(eq(sleepSegments.userId, USER), eq(sleepSegments.sessionId, session.id)));
    const awakenings = await late.select().from(sleepAwakenings).where(and(eq(sleepAwakenings.userId, USER), eq(sleepAwakenings.sessionId, session.id)));
    expect(awakenings.length).toBeGreaterThan(0);
    const m = dailyMetrics;
    const [metrics] = await late
      .select({ hrvMs: m.hrvMs, hrvDeepMs: m.hrvDeepMs, rhrBpm: m.rhrBpm, rhrMethod: m.rhrMethod, nonRemHrBpm: m.nonRemHrBpm, respBpm: m.respBpm, nightlyTempC: m.nightlyTempC, spo2Pct: m.spo2Pct })
      .from(m)
      .where(and(eq(m.userId, USER), eq(m.day, day)));
    await late.delete(s).where(and(eq(s.userId, USER), eq(s.id, session.id)));
    await late.delete(sleepSegments).where(and(eq(sleepSegments.userId, USER), eq(sleepSegments.sessionId, session.id)));
    const cleared = Object.fromEntries(Object.keys(metrics).map((k) => [k, null]));
    await late.update(m).set(cleared).where(and(eq(m.userId, USER), eq(m.day, day)));
    await recompute(late, OPTS);
    expect((await recovery(late, day)).reason).toBe("band_not_worn");

    // The night syncs late: the source writes the rows (no HR changed, so nothing is marked dirty).
    await late.insert(s).values(session);
    if (segments.length) await late.insert(sleepSegments).values(segments);
    await late.insert(sleepAwakenings).values(awakenings);
    await late.update(m).set(metrics).where(and(eq(m.userId, USER), eq(m.day, day)));
    await recompute(late, OPTS);
    // Only the days the night touches rerun stage 1: the morning it ended, and the evening before if it started then.
    const startedBefore = session.startTs < localMidnight(day, TZ);
    expect(lastRun.stage1Days).toEqual(startedBefore ? [at(199), day] : [day]);

    await recompute(full, OPTS);
    expect(await dump(late, "daily_scores", "1, 2")).toBe(await dump(full, "daily_scores", "1, 2"));
    expect(await dump(late, "intraday_series", "1, 2, 3")).toBe(await dump(full, "intraday_series", "1, 2, 3"));
    expect(await dump(late, "reports", "1, 2")).toBe(await dump(full, "reports", "1, 2"));
  }, 120_000);
});
