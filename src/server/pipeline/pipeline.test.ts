import { beforeAll, describe, expect, it } from "vitest";
import { type Db, rows, sql } from "../db";
import {
  type HealthMonitorRow,
  type HealthspanRow,
  type JournalImpactRow,
  lastRun,
  needsRecompute,
  recompute,
  type RecoveryRow,
  SCORING_VERSION,
  type SleepRow,
  type Stage1Day,
  type StrainTargetRow,
} from ".";
import { healthspanWornAwakeMin } from "./scores";
import { energyStart } from "@/core/algorithms/energyBank";
import { healthspanConfig } from "@/core/algorithms/healthspan";
import { logisticK, logisticScore, logisticZ0, sleepPerfScale, wHRV, wResp, wRHR, wSkinTemp, wSleep } from "@/core/scoring/recovery";
import { journalImpactConfig } from "@/core/algorithms/journalImpact";
import { forecast as recoveryForecast } from "@/core/scoring/forecast";
import { personalizedNeedHours } from "@/core/scoring/sleep";
import { trimpToStrain } from "@/core/scoring/strain";
import { load } from "./data";
import { stage1 } from "./stage1";
import { seedPull } from "../sources/seed/generate";
import { copyDb, DAY_S, dayAt, dump, freshDb, NOW, OPTS, seeded, TZ, PROFILE, USER } from "../testing";
import { addDays, localMidnight } from "../time";

const COLS = new Set(["strain", "recovery", "sleep", "training_load", "strain_target", "health_monitor", "journal_impact"]);
const json = async <T>(db: Db, col: string, day: string) => {
  if (!COLS.has(col)) throw new Error(col);
  const [r] = await rows<{ v: T }>(db, sql`select ${sql.identifier(col)} v from daily_scores where user_id = ${USER} and day = ${day}`);
  return r.v;
};
const days = async (db: Db) =>
  (await rows<{ day: string }>(db, sql`select day from daily_scores where user_id = ${USER} order by day`)).map((r) => r.day);
const rowsBefore = async (db: Db, day: string) =>
  JSON.stringify(await rows(db, sql`select * from daily_scores where user_id = ${USER} and day < ${day} order by day`));
const dirtyDays = async (db: Db) =>
  (await rows<{ day: string }>(db, sql`select day from intraday_dirty where user_id = ${USER} order by day`)).map((r) => r.day);
const setVersion = (db: Db, v: number, day?: string) =>
  db.execute(sql`update daily_scores set scoring_version = ${v} where user_id = ${USER} ${day ? sql`and day = ${day}` : sql``}`);
/** Row versions of everything stage 2 writes: unchanged xmins mean no row was written. */
const xmins = async (db: Db) =>
  JSON.stringify(
    await rows(
      db,
      sql`select (select array_agg(xmin::text order by day) from daily_scores) s,
        (select array_agg(xmin::text order by day, kind) from intraday_series) i,
        (select array_agg(xmin::text order by period) from reports) r`,
    ),
  );
const seedOpts = (now: number) => ({ userId: USER, now, timeZone: TZ, maxHr: PROFILE.maxHr });

let db: Db;
// Read once for the tests that only look at the seeded scores.
let scores: Map<string, Record<string, unknown>>;
let metrics: Map<string, Record<string, unknown>>;
let allDays: string[];
const js = <T>(col: string, day: string) => scores.get(day)![col] as T;
beforeAll(async () => {
  db = await seeded();
  scores = new Map((await rows<Record<string, unknown>>(db, sql`select * from daily_scores where user_id = ${USER}`)).map((r) => [r.day as string, r]));
  metrics = new Map((await rows<Record<string, unknown>>(db, sql`select * from daily_metrics where user_id = ${USER}`)).map((r) => [r.day as string, r]));
  allDays = [...scores.keys()].sort();
});

describe("recompute on the 180-day seed", () => {
  it("scores every day once, under the current scoring version", async () => {
    expect(await days(db)).toHaveLength(180);
    expect((await days(db))[0]).toBe(dayAt(0));
    const versions = await rows<{ v: number }>(db, sql`select distinct scoring_version v from daily_scores`);
    expect(versions.map((r) => r.v)).toEqual([SCORING_VERSION]);
  });

  it("is deterministic: a second run reads no HR, writes nothing and leaves daily_scores byte-identical", async () => {
    const before = await dump(db, "daily_scores");
    const x0 = await xmins(db);
    await recompute(db, OPTS);
    expect(lastRun.stage1Days).toEqual([]);
    expect(await xmins(db)).toBe(x0);
    expect(await dump(db, "daily_scores")).toBe(before);
  });

  it("matches a from-scratch run on an identical database", async () => {
    // Built here, not copied from the shared template, so this also checks the template.
    const other = await seeded([NOW], { compute: false });
    await recompute(other, OPTS);
    expect(await dump(other, "daily_scores", "1, 2")).toBe(await dump(db, "daily_scores", "1, 2"));
    expect(await dump(other, "intraday_series", "1, 2, 3")).toBe(await dump(db, "intraday_series", "1, 2, 3"));
    expect(await dump(other, "reports", "1, 2")).toBe(await dump(db, "reports", "1, 2"));
  });

  it("stage 1 reruns only today when only today's HR changes", async () => {
    const later = await copyDb(db);
    await seedPull(later, seedOpts(NOW + 3600));
    expect(await dirtyDays(later)).toEqual([dayAt(179)]);
    await recompute(later, OPTS);
    expect(lastRun.stage1Days).toEqual([dayAt(179)]);
    expect(await dirtyDays(later)).toEqual([]);
  });

  it("a scoring-version change recomputes every day exactly once", async () => {
    const bumped = await copyDb(db);
    await setVersion(bumped, SCORING_VERSION - 1);
    await recompute(bumped, OPTS);
    expect(lastRun.stage1Days).toEqual(await days(db));
    expect(new Set(lastRun.stage1Days).size).toBe(180);
    await recompute(bumped, OPTS);
    expect(lastRun.stage1Days).toEqual([]);
    expect(await dump(bumped, "daily_scores", "1, 2")).toBe(await dump(db, "daily_scores", "1, 2"));
  });

  it("is causal: a day later, every earlier day is unchanged", async () => {
    const later = await copyDb(db);
    await seedPull(later, seedOpts(NOW + DAY_S));
    await recompute(later, OPTS);
    expect(await days(later)).toHaveLength(181);
    expect(await rowsBefore(later, dayAt(179))).toBe(await rowsBefore(db, dayAt(179)));
    // Today itself gained the rest of the day, so its strain moves; its recovery does not.
    expect(await json<RecoveryRow>(later, "recovery", dayAt(179))).toEqual(await json<RecoveryRow>(db, "recovery", dayAt(179)));
  });

  it("scopes by user: another user's recompute leaves this user's rows alone", async () => {
    const two = await copyDb(db);
    const before = await dump(two, "daily_scores", "1, 2");
    const [{ id }] = await rows<{ id: number }>(two, sql`insert into "user" (name, email, email_verified) values ('B', 'b@pulse.test', true) returning id`);
    await recompute(two, { ...OPTS, userId: id });
    expect(lastRun.stage1Days).toEqual([]);
    expect(await needsRecompute(two, USER)).toBe(false);
    expect(await dump(two, "daily_scores", "1, 2")).toBe(before);
  });
});

describe("needsRecompute", () => {
  it("is false after a full recompute", async () => {
    expect(await needsRecompute(db, USER)).toBe(false);
  });

  it("is true with a dirty day", async () => {
    const dirty = await copyDb(db);
    await dirty.execute(sql`insert into intraday_dirty (user_id, day) values (${USER}, ${dayAt(10)})`);
    expect(await needsRecompute(dirty, USER)).toBe(true);
  });

  it("is true when a row carries another scoring version", async () => {
    const old = await copyDb(db);
    await setVersion(old, SCORING_VERSION - 1, dayAt(10));
    expect(await needsRecompute(old, USER)).toBe(true);
  });

  it("is false on an empty database", async () => {
    expect(await needsRecompute(await freshDb({ install: false }), USER)).toBe(false);
  });

  // Failure injection: stage 1 commits, then the process dies before stage 2 does.
  const crashBetweenStages = async (d: Db) => stage1(d, (await load(d, OPTS))!, OPTS);

  it("stays true after a crash between the stages, and the next run catches up", async () => {
    const later = await copyDb(db);
    await seedPull(later, seedOpts(NOW + DAY_S)); // new HR, a new day
    const reference = await copyDb(later);
    await recompute(reference, OPTS);

    await crashBetweenStages(later);
    expect(await needsRecompute(later, USER)).toBe(true);
    await recompute(later, OPTS);
    expect(await needsRecompute(later, USER)).toBe(false);
    expect(await dump(later, "daily_scores", "1, 2")).toBe(await dump(reference, "daily_scores", "1, 2"));
  });

  it("a scoring-version change survives a crash between the stages", async () => {
    const bumped = await copyDb(db);
    await setVersion(bumped, SCORING_VERSION - 1);
    await crashBetweenStages(bumped);
    expect(await needsRecompute(bumped, USER)).toBe(true);
    await recompute(bumped, OPTS);
    expect(await dump(bumped, "daily_scores", "1, 2")).toBe(await dump(db, "daily_scores", "1, 2"));
  });

  it("a check-in's dirty mark refreshes journal impact, causally and deterministically", async () => {
    const logged = await copyDb(db);
    // What saveJournalEntry writes: the entry, and the day marked dirty.
    await logged.execute(sql`insert into journal_entries (user_id, day, tag, value) values (${USER}, ${dayAt(170)}, 'cold_plunge', 1)`);
    await logged.execute(sql`insert into intraday_dirty (user_id, day) values (${USER}, ${dayAt(170)})`);
    expect(await needsRecompute(logged, USER)).toBe(true);
    await recompute(logged, OPTS);
    expect(lastRun.stage1Days).toEqual([dayAt(170)]);
    expect(await needsRecompute(logged, USER)).toBe(false);
    const tags = async (day: string) => (await json<JournalImpactRow>(logged, "journal_impact", day)).impacts.map((i) => i.tag);
    expect(await tags(dayAt(179))).toContain("cold_plunge");
    expect(await tags(dayAt(170))).not.toContain("cold_plunge"); // a day's impact reads only earlier check-ins
    expect(await rowsBefore(logged, dayAt(171))).toBe(await rowsBefore(db, dayAt(171)));
    const after = await dump(logged, "daily_scores", "1, 2");
    await recompute(logged, OPTS);
    expect(await dump(logged, "daily_scores", "1, 2")).toBe(after);
  });

  it("journal impact is memoised on its inputs and the method version: a new method recomputes unchanged inputs", async () => {
    const copy = await copyDb(db);
    const day = dayAt(179);
    // Replace the stored result with a marker, keep its key, and make stage 2 run (a dirty day before it).
    const mark = async () => {
      await copy.execute(sql`update daily_scores set journal_impact = jsonb_set(journal_impact, '{impacts}', '[]') where user_id = ${USER} and day = ${day}`);
      await copy.execute(sql`insert into intraday_dirty (user_id, day) values (${USER}, ${dayAt(170)}) on conflict do nothing`);
    };
    const stored = async () => (await json<JournalImpactRow>(copy, "journal_impact", day)).impacts.length;
    await mark();
    await recompute(copy, OPTS);
    expect(await stored()).toBe(0); // same inputs, same version: the stored result is reused
    const keep = journalImpactConfig.version;
    journalImpactConfig.version = keep + 1;
    try {
      await mark();
      await recompute(copy, OPTS);
      expect(await stored()).toBeGreaterThan(0); // a new version: recomputed although the inputs did not change
    } finally {
      journalImpactConfig.version = keep;
    }
  });

  it("journal impact on the seed (SCORING_VERSION 18): alcohol is clear, the late-meal false positive is gone", async () => {
    const fx = Object.fromEntries((await json<JournalImpactRow>(db, "journal_impact", dayAt(179))).impacts.map((t) => [t.tag, t.effects]));
    // Alcohol: the generator lowers HRV ×0.88 and raises resting HR 3 bpm the next morning.
    expect(fx.alcohol.recovery.label).toBe("negative");
    expect(fx.alcohol.recovery.delta!).toBeLessThan(-15);
    expect(fx.alcohol.hrvZ.label).toBe("negative");
    // Late meals have no built-in effect; the 90% bootstrap labelled their sleep +1.15 "positive".
    for (const m of ["recovery", "hrvZ", "sleepPerf"] as const) expect(["no_clear_effect", "possible_positive", "possible_negative"]).toContain(fx.late_meal[m].label);
    // Every stored effect carries its means and p, and Δ = mean(yes) − mean(no).
    for (const e of Object.values(fx).flatMap((x) => Object.values(x))) {
      if (e.label === "not_enough_data") continue;
      expect(e.delta!).toBeCloseTo(e.meanYes! - e.meanNo!, 9);
      expect(e.p!).toBeGreaterThanOrEqual(0);
      expect(e.p!).toBeLessThanOrEqual(1);
    }
  });
});

describe("scale contracts", () => {
  it("Recovery's sleepPerf is sleep performance / 100 on [0, 1], never 0–100", () => {
    let checked = 0;
    for (const d of allDays) {
      const rec = js<RecoveryRow>("recovery", d);
      const sleep = js<SleepRow>("sleep", d);
      if (rec.inputs.sleepPerf == null) continue;
      expect(rec.inputs.sleepPerf).toBeGreaterThanOrEqual(0);
      expect(rec.inputs.sleepPerf).toBeLessThanOrEqual(1);
      if (sleep.performance != null) {
        expect(rec.inputs.sleepPerf).toBeCloseTo(sleep.performance / 100, 12);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(150);
  });

  it("stores Effort on 0–100 and Strain Target on 0–21", () => {
    const efforts = allDays.map((d) => js<{ effort: number | null }>("strain", d).effort).filter((e): e is number => e != null);
    expect(efforts.length).toBeGreaterThan(170);
    expect(Math.max(...efforts)).toBeLessThanOrEqual(100);
    // A training day's Effort is above 21, so it cannot be on the 0–21 axis.
    expect(Math.max(...efforts)).toBeGreaterThan(21);
    for (const d of allDays) {
      const t = js<StrainTargetRow>("strain_target", d);
      if (t.reason !== null) continue;
      expect(t.low).toBeGreaterThanOrEqual(4);
      expect(t.high).toBeLessThanOrEqual(19);
      // Version 11: about one Strain point wide (÷1.25 … ×1.25 in load), around a personal typical session on 0–21.
      expect(t.high - t.low).toBeGreaterThan(0.5);
      expect(t.high - t.low).toBeLessThan(1.5);
      expect(t.base).toBeGreaterThan(4);
      expect(t.base).toBeLessThanOrEqual(21);
    }
    // The first target (day 8) is built from the person's own 7 days, not the fixed 14–18 green range.
    const first = js<StrainTargetRow>("strain_target", dayAt(7));
    expect(first).toMatchObject({ reason: null, coldStart: true });
    if (first.reason === null) expect(first.high).toBeLessThan(14);
  });

  it("feeds Training load one row per calendar day on linear TRIMP; band-off days are a gap it carries", () => {
    for (const d of allDays) {
      const s1 = js<{ effort: number | null; trimp: number | null; hrCount: number }>("strain", d);
      // TRIMP is stored with Effort and is exactly what Effort is the log map of.
      expect(s1.trimp == null).toBe(s1.effort == null);
      if (s1.trimp != null) expect(trimpToStrain(s1.trimp)).toBe(s1.effort);
    }
    // The band is off from day 155 09:00 to day 157 23:52. Day 156 has no HR at all: a gap, which no longer restarts
    // the run (up to 3 days are carried). Day 157 has a few worn minutes, too few for Effort: a measured 0, as before.
    const run = (i: number) => js<{ contiguousDays: number; state: string }>("training_load", dayAt(i));
    expect(js<{ hrCount: number }>("strain", dayAt(156)).hrCount).toBe(0);
    expect(run(156).contiguousDays).toBe(run(155).contiguousDays);
    expect(run(157).contiguousDays).toBe(run(155).contiguousDays + 1);
    expect(run(158).contiguousDays).toBe(run(155).contiguousDays + 2);
    expect(run(158).state).toBe("established");
    expect(run(150).contiguousDays).toBe(151);
  });
});

describe("forecast strain nudge on the seed (SCORING_VERSION 12)", () => {
  it("never raises the forecast, and is no less accurate than leaving the strain term out", () => {
    type Fc = { charge: number; plannedSleepHours: number; needHours: number };
    const recs: number[] = [];
    let withTerm = 0;
    let withoutTerm = 0;
    let n = 0;
    for (let i = 0; i < allDays.length - 1; i++) {
      const rec = js<RecoveryRow & { forecast?: Fc | null }>("recovery", allDays[i]);
      if (rec.value != null) recs.push(rec.value);
      const fc = rec.forecast;
      if (!fc) continue;
      // The same forecast without the strain term (null typical session).
      const plain = recoveryForecast({ recentCharge: recs, todayLoad: null, plannedSleepHours: fc.plannedSleepHours, needHours: fc.needHours })!;
      expect(fc.charge).toBeLessThanOrEqual(plain.charge);
      const next = js<RecoveryRow>("recovery", allDays[i + 1]).value;
      if (next == null) continue;
      withTerm += Math.abs(next - fc.charge);
      withoutTerm += Math.abs(next - plain.charge);
      n++;
    }
    expect(n).toBeGreaterThan(140);
    expect(withTerm / n).toBeLessThanOrEqual(withoutTerm / n + 0.1);
  });
});
describe("stress on the seed (SCORING_VERSION 13)", () => {
  it("stored stress minutes never hold a lone high minute, and the counts match the minutes", async () => {
    const series = await rows<{ day: string; data: (number | null)[] }>(
      db,
      sql`select day, data from intraday_series where user_id = ${USER} and kind = 'stress' order by day`,
    );
    expect(series.length).toBeGreaterThan(150);
    // The series is stored to 2 dp, so a minute at exactly 2.00 may be a medium minute rounded up (1.995–1.999).
    const ambiguous = (v: number | null) => v === 2;
    for (const { day, data } of series) {
      for (let m = 0; m < data.length; m++) {
        const hi = (i: number) => data[i] != null && data[i]! >= 2;
        if (hi(m) && !ambiguous(data[m])) expect(hi(m - 1) || hi(m + 1), `${day} minute ${m}`).toBe(true);
      }
      const row = js<{ highMin: number } | null>("stress", day);
      if (row && "highMin" in row) {
        const sure = data.filter((v) => v != null && v > 2).length;
        expect(row.highMin).toBeGreaterThanOrEqual(sure);
        expect(row.highMin).toBeLessThanOrEqual(sure + data.filter(ambiguous).length);
      }
    }
  });
});

describe("sleep need on the seed (SCORING_VERSION 15)", () => {
  it("is the median of the prior 28 main nights, never below 7 h for an adult (7.5 h before 7 nights)", () => {
    const prior: number[] = [];
    for (const day of allDays) {
      const row = js<{ needHours: number; main: { asleepMin: number } | null }>("sleep", day);
      expect(row.needHours).toBeGreaterThanOrEqual(7);
      expect(row.needHours).toBeCloseTo(personalizedNeedHours(prior.slice(-28), 36), 9);
      if (prior.length < 7) expect(row.needHours).toBe(7.5);
      if (row.main) prior.push(row.main.asleepMin / 60);
    }
  });
});

describe("Recovery's sleep centre on the seed (SCORING_VERSION 17)", () => {
  it("is 0.85 for the first 7 nights, then the mean of the prior 28 nights' sleepPerf", () => {
    const prior: number[] = [];
    for (const day of allDays) {
      const inputs = js<RecoveryRow>("recovery", day).inputs as RecoveryRow["inputs"] & { sleepCentre?: number };
      expect(inputs.sleepCentre).toBeDefined();
      if (prior.length < 7) expect(inputs.sleepCentre).toBe(0.85);
      else {
        const recent = prior.slice(-28);
        expect(inputs.sleepCentre!).toBeCloseTo(recent.reduce((a, b) => a + b, 0) / recent.length, 12);
      }
      expect(inputs.sleepCentre!).toBeGreaterThanOrEqual(0.4);
      expect(inputs.sleepCentre!).toBeLessThanOrEqual(1);
      if (inputs.sleepPerf != null) prior.push(inputs.sleepPerf);
    }
  });
});

describe("recovery gating on the seed", () => {
  it("days 1–7 calibrate with the nights left, and day 8 is the first score", () => {
    for (let i = 0; i < 7; i++) {
      const r = js<RecoveryRow>("recovery", dayAt(i));
      expect(r).toMatchObject({ value: null, reason: "calibrating", nightsLeft: 7 - i });
    }
    const first = js<RecoveryRow>("recovery", dayAt(7));
    expect(first.value).toBeTypeOf("number");
    expect(first.provisional).toBe(true);
    expect(js<RecoveryRow>("recovery", dayAt(30)).provisional).toBe(false);
  });

  it("the no-HRV night and the band-off nights get reasons, not scores", () => {
    expect(js<RecoveryRow>("recovery", dayAt(164))).toMatchObject({ value: null, reason: "no_hrv_last_night" });
    expect(js<RecoveryRow>("recovery", dayAt(156))).toMatchObject({ value: null, reason: "band_not_worn" });
    expect(js<RecoveryRow>("recovery", dayAt(157))).toMatchObject({ value: null, reason: "band_not_worn" });
  });

  it("the skin-temperature gap leaves its baseline stale on day 100, and the term drops", () => {
    const r = js<RecoveryRow>("recovery", dayAt(100));
    expect(r.stale).toContain("skinTemp");
    expect(r.terms).not.toContain("skinTemp");
    expect(js<RecoveryRow>("recovery", dayAt(101)).terms).toContain("skinTemp");
  });
});

describe("Google's inputs first (docs/research/google-vs-pulse-metrics.md)", () => {
  const metric = (day: string, col: string) => metrics.get(day)![col] as number | null;

  it("zones are five on heart-rate reserve from the day's resting HR, with or without Google's zones", () => {
    for (const d of [dayAt(120), dayAt(157)]) {
      const s1 = js<Stage1Day>("strain", d);
      const reserve = s1.maxHr - s1.restingHr;
      expect(s1.zoneLower).toEqual([0.5, 0.6, 0.7, 0.8, 0.9].map((e) => Math.round((s1.restingHr + e * reserve) * 10) / 10));
      expect(s1.zoneSeconds).toHaveLength(5);
    }
  });

  it("Recovery and Strain read Google's daily resting HR, not the sleep-session estimate", () => {
    const rhr = metric(dayAt(120), "rhr_bpm");
    expect(js<RecoveryRow>("recovery", dayAt(120)).inputs.rhr).toBe(rhr);
    expect(js<Stage1Day>("strain", dayAt(120))).toMatchObject({ restingHr: rhr, restingHrSource: "daily" });
  });

  it("skin temperature: nightly − Google's baseline; Health Monitor takes Google's ranges", () => {
    const d = dayAt(120);
    const dev = (metric(d, "nightly_temp_c") as number) - (metric(d, "temp_baseline_c") as number);
    expect(js<RecoveryRow>("recovery", d).inputs.skinTempDev).toBeCloseTo(dev, 9);
    const hm = js<HealthMonitorRow>("health_monitor", d);
    if (hm.reason !== null) throw new Error("no health monitor");
    const by = Object.fromEntries(hm.vitals.map((v) => [v.key, v]));
    expect(by.restingHr).toMatchObject({ rangeSource: "google", range: { low: metric(d, "rhr_range_low"), high: metric(d, "rhr_range_high") } });
    expect(by.hrv).toMatchObject({ rangeSource: "google", range: { low: metric(d, "hrv_range_low"), high: metric(d, "hrv_range_high") } });
    const sd = metric(d, "temp_sd_c") as number;
    expect(by.skinTempDev).toMatchObject({ rangeSource: "google", range: { low: -2 * sd, high: 2 * sd } });
    expect(by.resp.rangeSource).toBe("pulse");
  });
});

describe("Pulse Age on the seed (SCORING_VERSION 19)", () => {
  type Hs = HealthspanRow;
  type S1 = { hrMinutesAm: number; hrMinutesPm: number };

  it("no result before 14 days of activity data; the calibrating rows count them", () => {
    const first = allDays.findIndex((d) => js<Hs>("healthspan", d).reason === null);
    expect(first).toBe(healthspanConfig.minActivityDays - 1);
    for (const d of allDays.slice(0, first)) {
      const h = js<Hs>("healthspan", d);
      expect(h).toMatchObject({ reason: "calibrating" });
      expect((h as { activityDays: number }).activityDays).toBe(allDays.indexOf(d) + 1);
    }
  });

  it("days worn under 10 h while awake are not activity days (the band-off days and today so far)", async () => {
    // Awake wear = minutes with heart rate − minutes of sleep sessions inside the day, as the pipeline counts it.
    const sessions = await rows<{ s: number; e: number }>(db, sql`select start_ts s, end_ts e from sleep_sessions where user_id = ${USER}`);
    const awake = (d: string) => {
      const lo = localMidnight(d, TZ);
      const hi = localMidnight(addDays(d, 1), TZ);
      const asleep = sessions.filter((x) => Number(x.e) > lo && Number(x.s) < hi).reduce((a, x) => a + (Math.min(Number(x.e), hi) - Math.max(Number(x.s), lo)) / 60, 0);
      const s1 = js<S1>("strain", d);
      return s1.hrMinutesAm + s1.hrMinutesPm - asleep;
    };
    const light = allDays.filter((d) => awake(d) < healthspanWornAwakeMin);
    expect(light.length).toBeGreaterThanOrEqual(3); // the three band-off days, and today in progress
    // Every day worn around the clock passes, however long its sleep.
    const allDay = allDays.filter((d) => js<S1>("strain", d).hrMinutesAm + js<S1>("strain", d).hrMinutesPm >= 1400);
    expect(allDay.length).toBeGreaterThan(170);
    expect(allDay.filter((d) => light.includes(d))).toEqual([]);
    for (const d of allDays) {
      const h = js<Hs>("healthspan", d);
      const window = allDays.filter((x) => x <= d && x > addDays(d, -180));
      const expected = window.filter((x) => !light.includes(x)).length;
      expect(h.reason === null ? h.activityDays : (h as { activityDays: number }).activityDays).toBe(expected);
    }
  });

  it("after the gate the score is stable: no day-to-day move above 0.6 years, and Pace stays in [−1, 3]", () => {
    let prev: number | null = null;
    for (const d of allDays) {
      const h = js<Hs>("healthspan", d);
      if (h.reason !== null) continue;
      if (prev != null) expect(Math.abs(h.deltaYears - prev)).toBeLessThan(0.6);
      expect(h.paceOfAging).toBeGreaterThanOrEqual(-1);
      expect(h.paceOfAging).toBeLessThanOrEqual(3);
      prev = h.deltaYears;
    }
  });

  it("the demo user (active, logs strength, a weekly run) scores younger against the guidelines reference", () => {
    const h = js<Hs>("healthspan", allDays.at(-1)!);
    if (h.reason !== null) throw new Error("no result");
    expect(h.deltaYears).toBeLessThan(0);
    expect(h.vo2maxSource).toBe("blend");
    expect(h.vo2maxRuns).toBeGreaterThan(0);
    expect(h.contributions.find((c) => c.key === "strength")!.unlogged).toBeUndefined();
  });
});

describe("the Energy Bank counts last night's sleep once (SCORING_VERSION 20)", () => {
  type EB = { value: number | null; startLevel?: number };
  const W: Record<string, number> = { hrv: wHRV, rhr: wRHR, resp: wResp, sleep: wSleep, skinTemp: wSkinTemp };

  it("recovery.withoutSleep is the same Recovery with its sleep term removed", () => {
    let checked = 0;
    for (const d of allDays) {
      const r = js<RecoveryRow>("recovery", d);
      if (r.value == null) {
        expect(r.withoutSleep ?? null).toBeNull();
        continue;
      }
      expect(r.withoutSleep).not.toBeNull();
      if (!r.terms.includes("sleep")) {
        expect(r.withoutSleep).toBe(r.value);
        continue;
      }
      // Rebuild: the shown score's composite z, minus the sleep term, renormalised over the remaining weights.
      const total = r.terms.reduce((a, t) => a + W[t], 0);
      const z = logisticZ0 - Math.log(100 / r.value - 1) / logisticK;
      const zSleep = (r.inputs.sleepPerf! - r.inputs.sleepCentre!) / sleepPerfScale;
      const expected = logisticScore((z * total - zSleep * wSleep) / (total - wSleep));
      if (r.value > 0.5 && r.value < 99.5) {
        expect(r.withoutSleep!).toBeCloseTo(expected, 6);
        checked++;
      }
      // The composite is a weighted average: the shown score sits above the body-only one exactly when the sleep term
      // beat the other terms' average (not merely when sleep beat your usual night).
      const zBody = (z * total - zSleep * wSleep) / (total - wSleep);
      const gap = r.value - r.withoutSleep!;
      if (Math.abs(zSleep - zBody) > 1e-6 && r.value > 0.5 && r.value < 99.5) expect(Math.sign(gap)).toBe(Math.sign(zSleep - zBody));
    }
    expect(checked).toBeGreaterThan(120);
  });

  it("every day starts at energyStart(withoutSleep, sleep performance)", () => {
    let n = 0;
    for (const d of allDays) {
      const eb = js<EB>("energy_bank", d);
      if (eb.value == null) continue;
      const r = js<RecoveryRow>("recovery", d);
      const s = js<SleepRow>("sleep", d);
      expect(eb.startLevel!).toBeCloseTo(energyStart(r.withoutSleep!, s.performance ?? s.main!.efficiency * 100), 9);
      n++;
    }
    expect(n).toBeGreaterThan(150);
  });

  it("the scale is unchanged: typical days still end in 15–40, and few run out", () => {
    const ebs = allDays.map((d) => js<EB>("energy_bank", d)).filter((e) => e.value != null);
    const starts = ebs.map((e) => e.startLevel!);
    const mean = starts.reduce((a, b) => a + b, 0) / starts.length;
    expect(Math.abs(mean - 70.9)).toBeLessThan(1.5); // version 19's mean start on the seed
    expect(ebs.filter((e) => e.value! >= 15 && e.value! <= 40).length).toBeGreaterThanOrEqual(85);
    expect(ebs.filter((e) => e.value! <= 0.01).length).toBeLessThanOrEqual(12);
  });
});
