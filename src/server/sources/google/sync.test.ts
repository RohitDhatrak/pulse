import fs from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, row } from "../../db";
import {
  dailyMetrics,
  dailyScores,
  exercises,
  hrDays,
  intradayDirty,
  oauthTokens,
  rawPayloads,
  sleepSegments,
  sleepSessions,
  stepsDays,
  syncState,
} from "../../db/schema";
import { readSamples, writeSamples } from "../../samples";
import { addUser, freshDb, USER } from "../../testing";
import { RAW_RETENTION_DAYS } from "./client";
import { recompute } from "../../pipeline";
import { GoogleError } from "./oauth";
import { BACKFILL_DAYS, createGoogleSource, DEVICES_KEY, NO_DEVICE_ERROR } from "./sync";

const TZ = "Asia/Kolkata"; // fixed +05:30, which the stub's civil-time filter relies on
const NOW = Date.parse("2026-10-02T06:00:00Z"); // 11:30 local
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

type Obj = Record<string, unknown>;
const at = (v: unknown, p: string) => p.split(".").reduce<unknown>((o, k) => (o as Obj | undefined)?.[k], v);
const civil = (d: unknown) =>
  ["year", "month", "day"].map((k, i) => String(at(d, k)).padStart(i ? 2 : 4, "0")).join("-");
const fixture = (name: string): unknown[] => {
  const j = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "__fixtures__", `${name}.json`), "utf8"));
  return j.dataPoints ?? j.rollupDataPoints;
};
const LIST_TYPES = [
  "daily-heart-rate-variability",
  "daily-resting-heart-rate",
  "daily-respiratory-rate",
  "daily-sleep-temperature-derivations",
  "daily-oxygen-saturation",
  "daily-vo2-max",
  "daily-heart-rate-zones",
  "run-vo2-max",
  "weight",
  "body-fat",
  "sleep",
  "exercise",
  "heart-rate",
  "steps",
];
const camel = (s: string) => s.replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase());
const payload = (p: unknown, type: string) => at(p, camel(type)) as Obj;

/** The member value a filter compares, as a sortable number or civil date string. */
function memberValue(p: unknown, type: string, member: string): number | string {
  const o = payload(p, type);
  if (member === "date") return civil(o.date);
  if (member === "interval.civil_start_time") return Date.parse(String(at(o, "interval.startTime")));
  return Date.parse(String(at(o, camel(member))));
}
const bound = (member: string, s: string) =>
  member === "date" ? s : member === "interval.civil_start_time" ? Date.parse(`${s}+05:30`) : Date.parse(s);

let db: Db;
let data: Record<string, unknown[]>;
const grant = (userId: number) =>
  db.insert(oauthTokens).values({ userId, accessToken: "at", refreshToken: "rt", expiresAt: NOW / 1000 + 86_400, scope: "s", updatedAt: NOW / 1000 });
beforeEach(async () => {
  db = await freshDb();
  await grant(USER);
  data = Object.fromEntries(LIST_TYPES.map((t) => [t, fixture(t)]));
  data["steps:rollup"] = fixture("steps.dailyRollUp");
  data["total-calories:rollup"] = fixture("total-calories.dailyRollUp");
  for (const t of ["time-in-heart-rate-zone", "daily-resting-heart-rate", "daily-heart-rate-variability"]) data[`${t}:rollup`] = fixture(`${t}.dailyRollUp`);
});

/** A source over a stubbed Google that answers each request from the fixtures inside its window. */
function setup(o: { failing?: string[]; failStatus?: number; onRequest?: (type: string, filter: string | null) => void | Promise<void>; devices?: () => Response } = {}) {
  let clock = NOW;
  const calls: { type: string; filter: string | null }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/pairedDevices")) return o.devices?.() ?? json({ pairedDevices: [{ name: "users/me/pairedDevices/1" }] });
    const [, type, rollup] = /dataTypes\/([^/]+)\/dataPoints(:dailyRollUp)?$/.exec(url.pathname)!;
    const filter = url.searchParams.get("filter");
    calls.push({ type, filter });
    await o.onRequest?.(type, filter);
    if (o.failing?.includes(type)) {
      return json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "secret body text" } }, o.failStatus ?? 400);
    }
    if (rollup) {
      const { range } = JSON.parse(String(init.body));
      const [lo, hi] = [civil(range.start.date), civil(range.end.date)];
      const pts = data[`${type}:rollup`].filter((p) => {
        const d = civil(at(p, "civilStartTime.date"));
        return d >= lo && d < hi;
      });
      return json({ rollupDataPoints: pts });
    }
    const [, member, lo, hi] = /^\w+\.(\S+) >= "([^"]+)" AND \S+ < "([^"]+)"$/.exec(filter!)!;
    const pts = data[type].filter((p) => {
      const v = memberValue(p, type, member);
      return v >= bound(member, lo) && v < bound(member, hi);
    });
    return json({ dataPoints: pts });
  }) as unknown as typeof globalThis.fetch;
  const log = { error: vi.fn() };
  const source = createGoogleSource({
    db,
    google: { clientId: "cid", clientSecret: "cs" },
    timeZone: TZ,
    fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log,
  });
  return {
    source,
    calls,
    log,
    advance: (ms: number) => (clock += ms),
  };
}

/** Rows per table for the user; heart rate and steps count samples (they are stored as day arrays). */
const counts = async (userId = USER) => {
  const n = async (t: typeof dailyMetrics | typeof sleepSessions | typeof sleepSegments | typeof exercises) =>
    (await db.select({ n: sql<number>`count(*)` }).from(t).where(eq(t.userId, userId)))[0].n;
  const samples = async (t: typeof hrDays | typeof stepsDays) =>
    (await row<{ n: number }>(db, sql`select coalesce(sum(cardinality(${t.offsets})), 0)::int as n from ${t} where ${t.userId} = ${userId}`))!.n;
  return {
    dailyMetrics: await n(dailyMetrics),
    sleepSessions: await n(sleepSessions),
    sleepSegments: await n(sleepSegments),
    exercises: await n(exercises),
    hrSamples: await samples(hrDays),
    stepsMinutes: await samples(stepsDays),
  };
};
const dirtyDays = async () => (await db.select().from(intradayDirty)).map((r) => r.day).sort();
const state = async (type: string) => (await db.select().from(syncState).where(and(eq(syncState.userId, USER), eq(syncState.type, type))))[0];
const day = async (d: string) => (await db.select().from(dailyMetrics).where(eq(dailyMetrics.day, d)))[0];
const clearDirty = () => db.delete(intradayDirty);
const lowerBound = (f: string | null) => /"([^"]+)"/.exec(f!)![1];

describe("google sync", () => {
  it("does nothing before the account is connected", async () => {
    await db.delete(oauthTokens);
    const { source, calls } = setup();
    expect(await source.pull(USER)).toEqual({ changed: false });
    expect(calls).toEqual([]);
  });

  it("first connect backfills 180 days oldest first, with monotonic N-of-180 progress", async () => {
    const progress: [number | null, number | null][] = [];
    const { source, calls } = setup({
      onRequest: (type, filter) => {
        if (type !== "heart-rate" || !filter) return; // the sample list, not the extra roll-up
        return state("heart-rate").then((s) => void progress.push([s?.backfillDaysDone ?? null, s?.backfillDaysTotal ?? null]));
      },
    });
    expect(await source.pull(USER)).toEqual({ changed: true });

    const hr = calls.filter((c) => c.type === "heart-rate" && c.filter);
    expect(hr).toHaveLength(BACKFILL_DAYS); // one local day per request
    expect(lowerBound(hr[0].filter)).toBe("2026-04-05T18:30:00.000Z"); // local midnight, 6 April
    const starts = hr.map((c) => Date.parse(lowerBound(c.filter)));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));

    expect(progress[0]).toEqual([0, 180]);
    progress.slice(1).forEach(([done], i) => expect(done).toBeGreaterThanOrEqual(progress[i][0]!));
    expect(progress.at(-1)).toEqual([179, 180]);
    expect(await state("heart-rate")).toMatchObject({ backfillDaysDone: 180, backfillDaysTotal: 180, lastError: null });

    // The normalized tables are filled the way the seed fills them.
    expect(await day("2026-10-01")).toEqual({
      userId: USER,
      day: "2026-10-01",
      hrvMs: 41.5,
      hrvDeepMs: 47,
      rhrBpm: 57,
      rhrMethod: "WITH_SLEEP",
      respBpm: 14.2,
      nightlyTempC: 34.12,
      spo2Pct: 96.4,
      vo2maxDaily: null,
      vo2maxRun: 46.3,
      steps: 8421,
      calories: 2310.5,
      weightKg: null,
      bodyFatPct: null,
      hrZones: [98, 118, 137, 157, 186],
      lightModerateMin: 52,
      vigorousPeakMin: 450.5 / 60,
      tempBaselineC: 34,
      tempSdC: 0.21,
      // Not fetched: the API refuses roll-ups on the daily types (UNSUPPORTED_DATA_TYPE_ACTION).
      rhrRangeLow: null,
      rhrRangeHigh: null,
      hrvRangeLow: null,
      hrvRangeHigh: null,
      source: "google",
    });
    expect(await counts()).toEqual({ dailyMetrics: 3, sleepSessions: 4, sleepSegments: 9, exercises: 1, hrSamples: 5, stepsMinutes: 5 });
    expect((await db.select().from(sleepSegments)).map((s) => s.stage)).not.toContain("AWAKE");
    expect(await dirtyDays()).toEqual(["2026-09-30", "2026-10-01", "2026-10-02"]);
  });

  it("re-importing the same payloads leaves row counts unchanged and reports no change", async () => {
    const { source } = setup();
    await source.pull(USER);
    const before = await counts();
    await clearDirty();

    expect(await source.pull(USER)).toEqual({ changed: false }); // incremental, overlapping every fixture
    await db.delete(syncState);
    expect(await source.pull(USER)).toEqual({ changed: false }); // a full second backfill
    expect(await counts()).toEqual(before);
    expect(await dirtyDays()).toEqual([]);
  });

  it("re-fetches heart rate from synced_through minus 1 hour and marks only today dirty", async () => {
    const { source, calls, advance } = setup();
    await source.pull(USER);
    await clearDirty();
    calls.length = 0;

    advance(15 * 60_000);
    data["heart-rate"].push({
      dataSource: { platform: "FITBIT", recordingMethod: "PASSIVELY_MEASURED" },
      heartRate: { beatsPerMinute: "70", sampleTime: { physicalTime: "2026-10-02T06:05:00Z" } },
    });
    expect(await source.pull(USER)).toEqual({ changed: true });

    // The last stored sample (05:50) is older than synced_through, so the hour runs back from it.
    const hr = calls.filter((c) => c.type === "heart-rate" && c.filter);
    expect(hr.map((c) => lowerBound(c.filter))).toEqual(["2026-10-02T04:50:00.000Z"]);
    // daily-* re-fetch 3 local days before synced_through.
    expect(lowerBound(calls.find((c) => c.type === "daily-resting-heart-rate")!.filter)).toBe("2026-09-29");
    expect(await dirtyDays()).toEqual(["2026-10-02"]);

    // Nothing new: nothing changes and nothing is dirty.
    await clearDirty();
    advance(15 * 60_000);
    expect(await source.pull(USER)).toEqual({ changed: false });
    expect(await dirtyDays()).toEqual([]);
  });

  it("one failing type does not block the others, and records only the safe error", async () => {
    const { source, log } = setup({ failing: ["daily-oxygen-saturation"] });
    expect(await source.pull(USER)).toEqual({ changed: true });

    const failed = (await state("daily-oxygen-saturation"))!;
    expect(failed.lastError).toBe("[google] daily-oxygen-saturation: INVALID_ARGUMENT (HTTP 400)");
    expect(failed.syncedThrough).toBeNull();
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("secret");

    expect(await state("heart-rate")).toMatchObject({ lastError: null, backfillDaysDone: 180 });
    expect((await state("daily-respiratory-rate"))?.lastError).toBeNull();
    expect(await day("2026-10-01")).toMatchObject({ spo2Pct: null, respBpm: 14.2, hrvMs: 41.5 });
  });

  it("records no paired device, clears it once one is paired, and keeps the last answer on an error or unknown shape", async () => {
    let devices = () => json({});
    const { source, log } = setup({ devices: () => devices() });
    await source.pull(USER);
    expect((await state(DEVICES_KEY))?.lastError).toBe(NO_DEVICE_ERROR);
    expect((await state("heart-rate"))?.lastError).toBeNull(); // the import itself still runs

    devices = () => json({ error: { code: 403, status: "PERMISSION_DENIED", message: "secret body text" } }, 403);
    await source.pull(USER);
    expect((await state(DEVICES_KEY))?.lastError).toBe(NO_DEVICE_ERROR);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("secret");

    devices = () => json({ somethingNew: true });
    await source.pull(USER);
    expect((await state(DEVICES_KEY))?.lastError).toBe(NO_DEVICE_ERROR);

    devices = () => json({ pairedDevices: [{ name: "users/me/pairedDevices/1" }] });
    await source.pull(USER);
    expect((await state(DEVICES_KEY))?.lastError).toBeNull();
  });

  it("each pull prunes raw pages older than the retention window", async () => {
    const { source } = setup();
    const old = NOW / 1000 - (RAW_RETENTION_DAYS + 1) * 86_400;
    await db.insert(rawPayloads).values({ userId: USER, type: "sleep", rangeStart: 0, rangeEnd: 1, bodyHash: "x", gzBody: Buffer.from(""), fetchedAt: old });
    await source.pull(USER);
    const kept = await db.select().from(rawPayloads);
    expect(kept.length).toBeGreaterThan(0); // this pull's pages
    expect(kept.every((r) => r.fetchedAt > old)).toBe(true);
  });

  describe("records deleted in Fitbit", () => {
    const OPTS = { userId: USER, timeZone: TZ, profile: { birthDate: "1990-01-01", sex: "male" as const, maxHr: 183, maxHrSource: "set" as const, heightCm: null, timeZone: TZ } };
    const ids = async (t: typeof sleepSessions | typeof exercises) => (await db.select({ id: t.id }).from(t)).map((r) => r.id.split("/").pop()).sort();
    const scores = async (day: string) => {
      const [r] = await db.select({ activities: dailyScores.activities, sleep: dailyScores.sleep }).from(dailyScores).where(eq(dailyScores.day, day));
      return { activities: r.activities as unknown[], sleep: r.sleep as { reason: string | null } };
    };
    const s = (iso: string) => Date.parse(iso) / 1000;

    it("a deleted workout and a deleted night leave the tables and the scores; older rows stay", async () => {
      const { source, advance } = setup();
      await source.pull(USER);
      // A night inside the 30-day session re-fetch that Google no longer returns: deleted days later, so pruned too.
      await db
        .insert(sleepSessions)
        .values({ userId: USER, id: "week-old", day: "2026-09-24", startTs: s("2026-09-23T17:00:00Z"), endTs: s("2026-09-24T01:00:00Z"), isMain: true, processed: true, source: "FITBIT" });
      // One outside it, gone from Google too: never re-checked, so kept.
      await db
        .insert(sleepSessions)
        .values({ userId: USER, id: "old-night", day: "2026-08-20", startTs: s("2026-08-19T17:00:00Z"), endTs: s("2026-08-20T01:00:00Z"), isMain: true, processed: true, source: "FITBIT" });
      await recompute(db, OPTS);
      expect((await scores("2026-10-01")).activities).toHaveLength(1);
      expect((await scores("2026-10-01")).sleep.reason).toBeNull();

      data.exercise = [];
      data.sleep = data.sleep.filter((p) => !String(at(p, "name")).endsWith("/sleep-a")); // the night ending 1 October
      advance(15 * 60_000);
      expect(await source.pull(USER)).toEqual({ changed: true });

      expect(await ids(exercises)).toEqual([]);
      expect(await ids(sleepSessions)).toEqual(["old-night", "sleep-b", "sleep-c", "sleep-d"]);
      expect((await db.select().from(sleepSegments)).filter((g) => g.sessionId.endsWith("/sleep-a"))).toEqual([]); // deleted with it
      expect(await dirtyDays()).toEqual(["2026-09-24", "2026-10-01"]);

      await recompute(db, OPTS);
      expect((await scores("2026-10-01")).activities).toEqual([]);
      expect((await scores("2026-10-01")).sleep.reason).toBe("band_not_worn");
    });

    it("a failed fetch, or a page with a point we cannot read, deletes nothing", async () => {
      await setup().source.pull(USER);
      const before = await counts();
      data.exercise = [];
      data.sleep = [];
      await setup({ failing: ["sleep", "exercise"] }).source.pull(USER);
      expect(await counts()).toEqual(before);

      // A changed shape: in the window, but unreadable, so the window can't vouch for what is missing.
      data.sleep = [{ name: "x", sleep: { interval: { endTime: "2026-10-01T01:40:00Z" } } }];
      data.exercise = [{ name: "y", exercise: { interval: { startTime: "2026-10-01T12:30:00Z" } } }];
      await setup().source.pull(USER);
      expect(await counts()).toEqual(before);
    });

    it("band HR samples Google no longer returns in the window are deleted, but an empty answer deletes nothing", async () => {
      const extra = { dataSource: { platform: "FITBIT" }, heartRate: { beatsPerMinute: "64", sampleTime: { physicalTime: "2026-10-02T05:30:00Z" } } };
      data["heart-rate"].push(extra);
      const { source, advance } = setup();
      await source.pull(USER);
      expect((await counts()).hrSamples).toBe(6);
      await clearDirty();

      data["heart-rate"] = data["heart-rate"].filter((p) => p !== extra);
      advance(15 * 60_000);
      expect(await source.pull(USER)).toEqual({ changed: true });
      expect((await readSamples(db, "hr", USER, 0, 2 ** 31)).map((r) => r.ts)).not.toContain(s("2026-10-02T05:30:00Z"));
      expect((await counts()).hrSamples).toBe(5);
      expect(await dirtyDays()).toEqual(["2026-10-02"]);

      data["heart-rate"] = [];
      advance(15 * 60_000);
      await source.pull(USER);
      expect((await counts()).hrSamples).toBe(5);
    });
  });

  it("syncs each user into their own rows; a user without a grant gets nothing", async () => {
    const other = await addUser(db);
    const third = await addUser(db);
    await grant(other);
    const { source } = setup();
    await source.pull(USER);
    expect(await counts(other)).toEqual({ dailyMetrics: 0, sleepSessions: 0, sleepSegments: 0, exercises: 0, hrSamples: 0, stepsMinutes: 0 });
    const mine = await counts();
    expect(await source.pull(other)).toEqual({ changed: true });
    expect(await counts(other)).toEqual(mine);
    expect(await counts()).toEqual(mine);
    expect(await source.pull(third)).toEqual({ changed: false });
    expect(await counts(third)).toMatchObject({ dailyMetrics: 0, hrSamples: 0 });
  });

  it("a failed backfill resumes from its last committed chunk", async () => {
    let fail = true;
    const { source, calls } = setup({
      onRequest: (type, filter) => {
        if (type === "heart-rate" && fail && lowerBound(filter) === "2026-07-01T18:30:00.000Z") throw new Error("offline");
      },
    });
    await source.pull(USER);
    const stuck = (await state("heart-rate"))!;
    expect(stuck.lastError).toBe("[google] heart-rate: network");
    expect(stuck.backfillDaysDone).toBeGreaterThan(0);
    expect(stuck.backfillDaysDone).toBeLessThan(180);

    fail = false;
    calls.length = 0;
    await source.pull(USER);
    const hr = calls.filter((c) => c.type === "heart-rate" && c.filter);
    expect(lowerBound(hr[0].filter)).toBe("2026-07-01T18:30:00.000Z");
    expect(await state("heart-rate")).toMatchObject({ backfillDaysDone: 180, lastError: null });
  });
});

describe("pullHeartRate (the live view's pull)", () => {
  const sec = (iso: string) => Date.parse(iso) / 1000;
  const hrPoint = (iso: string, bpm: number) => ({
    dataSource: { platform: "FITBIT", recordingMethod: "PASSIVELY_MEASURED" },
    heartRate: { beatsPerMinute: String(bpm), sampleTime: { physicalTime: iso } },
  });
  const upper = (f: string | null) => /< "([^"]+)"/.exec(f!)![1];

  it("lists heart-rate once, from the newest stored sample minus 10 minutes to now, and merges it", async () => {
    const { source, calls } = setup();
    await writeSamples(db, "hr", USER, [{ ts: sec("2026-10-02T05:50:30Z"), v: 60 }]);
    data["heart-rate"] = [hrPoint("2026-10-02T05:50:30Z", 60), hrPoint("2026-10-02T05:58:00Z", 77)];
    await source.pullHeartRate!(USER);
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("heart-rate");
    expect(lowerBound(calls[0].filter)).toBe("2026-10-02T05:40:00.000Z"); // minute-aligned, 10 min before 05:50:30
    expect(upper(calls[0].filter)).toBe("2026-10-02T06:00:00.000Z");
    expect(await readSamples(db, "hr", USER, sec("2026-10-02T05:00:00Z"), sec("2026-10-02T07:00:00Z"))).toEqual([
      { ts: sec("2026-10-02T05:50:30Z"), v: 60 },
      { ts: sec("2026-10-02T05:58:00Z"), v: 77 },
    ]);
    expect(await dirtyDays()).toEqual(["2026-10-02"]); // the next full run rescores it
    expect(await state("heart-rate")).toBeUndefined(); // the full sync's cursor is not moved
  });

  it("with nothing stored (or only older days), starts at today's local midnight", async () => {
    const { source, calls } = setup();
    await writeSamples(db, "hr", USER, [{ ts: sec("2026-09-28T05:00:00Z"), v: 60 }]);
    await source.pullHeartRate!(USER);
    expect(lowerBound(calls[0].filter)).toBe("2026-10-01T18:30:00.000Z"); // 00:00 in Asia/Kolkata
  });

  it("does not retry a 429: it throws at once for the worker to stop", async () => {
    const { source, calls } = setup({ failing: ["heart-rate"], failStatus: 429 });
    const err = await source.pullHeartRate!(USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleError);
    expect((err as GoogleError).status).toBe(429);
    expect(calls).toHaveLength(1);
  });
});
