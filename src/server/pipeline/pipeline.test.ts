import { beforeAll, describe, expect, it } from "vitest";
import { type Db, rows, sql } from "../db";
import { dailyMetrics } from "../db/schema";
import { and, eq } from "drizzle-orm";
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
import { vo2maxPercentile } from "@/core/algorithms/fitnessLevel";
import { healthspanConfig } from "@/core/algorithms/healthspan";
import { earlyCleanConfig, stillGateConfig } from "@/core/scoring/stressBase";
import { strainTargetConfig } from "@/core/algorithms/strainTarget";
import { hardOrLateWorkout, loadToStrain, typicalSession } from "@/core/scoring/load";
import { logisticK, logisticScore, logisticZ0, missingInputScale, sleepPerfScale, wHRV, wResp, wRHR, wSkinTemp, wSleep, type RecoveryTerm } from "@/core/scoring/recovery";
import { journalImpactConfig } from "@/core/algorithms/journalImpact";
import { heldNeedHours, ledger, personalizedNeedHours, rest } from "@/core/scoring/sleep";
import { mergeSamples, readHr } from "../samples";
import { trimpToStrain } from "@/core/scoring/strain";
import { acwrBand, dayRatio, ewmaLoads, monotonyMax } from "@/core/scoring/readiness";
import { load } from "./data";
import { stage1 } from "./stage1";
import { seedPull } from "../sources/seed/generate";
import { SCENARIO } from "../sources/seed/scenario";
import { copyDb, ctxFor, DAY_S, dayAt, dump, freshDb, NOW, OPTS, seeded, TZ, PROFILE, USER } from "../testing";
import { getSleep } from "../queries/sleep";
import { reasonCopy } from "@/lib/reasons";
import { addDays, localMidnight } from "../time";

const COLS = new Set(["strain", "recovery", "sleep", "training_load", "strain_target", "health_monitor", "journal_impact", "fitness", "stress"]);
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
    // the run (up to 3 days are carried). Day 157 has a few worn minutes, too few to have seen the day: since version 46
    // a gap too (it was a measured 0).
    const run = (i: number) => js<{ contiguousDays: number; state: string }>("training_load", dayAt(i));
    expect(js<{ hrCount: number }>("strain", dayAt(156)).hrCount).toBe(0);
    expect(js<{ hrCount: number }>("strain", dayAt(157)).hrCount).toBeGreaterThan(0);
    expect(run(156).contiguousDays).toBe(run(155).contiguousDays);
    expect(run(157).contiguousDays).toBe(run(155).contiguousDays);
    expect(run(158).contiguousDays).toBe(run(155).contiguousDays + 1);
    expect(run(158).state).toBe("established");
    expect(run(150).contiguousDays).toBe(151);
  });
});

describe("forecast strain nudge on the seed (SCORING_VERSION 12)", () => {
  it("never raises the forecast, and is no less accurate than leaving the strain term out", () => {
    type Fc = { charge: number; baseline: number; phi: number; sleepAdj: number };
    const recs: number[] = [];
    let withTerm = 0;
    let withoutTerm = 0;
    let n = 0;
    for (let i = 0; i < allDays.length - 1; i++) {
      const rec = js<RecoveryRow & { forecast?: Fc | null }>("recovery", allDays[i]);
      if (rec.value != null) recs.push(rec.value);
      const fc = rec.forecast;
      if (!fc) continue;
      // The same forecast without the strain term: level + φ̂ × (today − level) + the sleep nudge (version 38).
      const plain = { charge: Math.round(Math.min(100, Math.max(0, fc.baseline + fc.phi * (rec.value! - fc.baseline) + fc.sleepAdj))) };
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
  it("is the median of the prior 28 main nights held so it falls slowly (version 40), never below 7 h for an adult (7.5 h before 7 nights)", () => {
    const prior: number[] = [];
    let held: number | null = null;
    let lastPlanNeed: number | null = null;
    let fallen = 0;
    for (const day of allDays) {
      const row = js<{ needHours: number; main: { asleepMin: number } | null }>("sleep", day);
      expect(row.needHours).toBeGreaterThanOrEqual(7);
      expect(row.needHours).toBeCloseTo(held ?? personalizedNeedHours(prior.slice(-28), 36), 9);
      if (prior.length < 7) expect(row.needHours).toBe(7.5);
      // This morning's need is the one last evening's plan used.
      if (lastPlanNeed != null) expect(row.needHours * 60).toBeCloseTo(lastPlanNeed, 9);
      const learned = prior.length >= 7; // last evening's need came from 7+ nights, not the 7.5 h default
      if (row.main) prior.push(row.main.asleepMin / 60);
      const raw = personalizedNeedHours(prior.slice(-28), 36);
      const next = heldNeedHours(raw, learned ? held : null);
      if (held != null && next > raw) fallen++;
      held = next;
      lastPlanNeed = js<{ parts?: { baselineMin: number }; needMin?: number }>("sleep_planner", day).parts?.baselineMin ?? null;
    }
    expect(fallen).toBeGreaterThan(0); // the hold mattered on some seed days
  });
});

describe("the Sleep Planner on the seed (SCORING_VERSION 24)", () => {
  type Plan = { reason: null; needMin: number; efficiency: number; planningEfficiency: number; efficiencyFloored: boolean; inBedCapMin: number; capped: boolean; plans: { share: number; inBedMin: number; sleepMin: number }[] };
  const planned = () => allDays.map((day) => js<Plan | { reason: string }>("sleep_planner", day)).filter((p): p is Plan => p.reason === null);

  it("time in bed never passes the age cap (10 h at the seed's 36), and bedtimes assume at least 85 % efficiency", () => {
    const ps = planned();
    expect(ps.length).toBeGreaterThan(150);
    for (const p of ps) {
      expect(p.inBedCapMin).toBe(600);
      expect(p.planningEfficiency).toBe(Math.max(p.efficiency, 0.85));
      expect(p.efficiencyFloored).toBe(p.efficiency < 0.85);
      for (const x of p.plans) expect(x.inBedMin).toBeLessThanOrEqual(600 + 1e-9);
    }
  });

  it("uncapped plans are share × need ÷ planning efficiency: version 23's formula whenever efficiency is 85 % or more", () => {
    for (const p of planned().filter((p) => !p.capped)) {
      for (const x of p.plans) {
        expect(x.inBedMin).toBeCloseTo((x.share * p.needMin) / p.planningEfficiency, 9);
        expect(x.sleepMin).toBeCloseTo(x.share * p.needMin, 9);
      }
    }
  });
});

describe("naps on the seed (SCORING_VERSION 42)", () => {
  type Parts = { baselineMin: number; strainMin: number; debtMin: number; napMin: number; napAsleepMin: number };
  const planned = () => allDays.map((day) => js<{ reason: string | null; needMin: number; parts: Parts }>("sleep_planner", day)).filter((p) => p.reason === null);

  it("a nap never takes tonight's need under the baseline; it covers only the strain and debt extras", () => {
    const ps = planned();
    const napped = ps.filter((p) => p.parts.napAsleepMin > 0);
    expect(napped.length).toBeGreaterThanOrEqual(15); // 21 nap days; version 41 planned as little as 380 of a 446 min need
    for (const p of ps) {
      expect(p.needMin).toBeGreaterThanOrEqual(p.parts.baselineMin - 1e-9);
      expect(p.parts.napMin).toBeCloseTo(Math.min(p.parts.napAsleepMin, p.parts.strainMin + p.parts.debtMin), 9);
      expect(p.needMin).toBeCloseTo(p.parts.baselineMin + p.parts.strainMin + p.parts.debtMin - p.parts.napMin, 9);
    }
    expect(napped.filter((p) => p.parts.napAsleepMin > p.parts.napMin).length).toBeGreaterThanOrEqual(15); // 19
  });
});

describe("restorative targets by age on the seed (SCORING_VERSION 43)", () => {
  it("the seed (36) keeps 13 % / 50 %; the same nights at 70 score higher restorative sleep, and nothing else moves", async () => {
    const older = await seeded([NOW], { compute: false });
    await recompute(older, { ...OPTS, profile: { ...PROFILE, birthDate: "1956-01-01" } });
    const perf = async (d: Db) => new Map((await rows<{ d: string; s: SleepRow }>(d, sql`select day::text d, sleep s from daily_scores where user_id = ${USER} order by day`)).map((r) => [r.d, r.s]));
    const at36 = await perf(db);
    const at70 = await perf(older);
    let staged = 0;
    let lift = 0;
    for (const [day, s] of at36) {
      const o = at70.get(day)!;
      if (s.performance == null) {
        expect(o.performance).toBeNull();
        continue;
      }
      // Same nights, same need (both adults above the floor's taper), same duration and efficiency.
      expect(o.needHours).toBe(s.needHours);
      expect(o.main).toEqual(s.main);
      expect(o.performance!).toBeGreaterThanOrEqual(s.performance - 1e-9);
      if (s.restorative === "measured") {
        staged++;
        lift += o.performance! - s.performance;
      }
    }
    expect(staged).toBeGreaterThan(100);
    // The seed's deep sleep is a 36-year-old's, so at 70 it sits above the eased targets: mean 91.4 → 94.2.
    expect(lift / staged).toBeGreaterThan(2);
    expect(lift / staged).toBeLessThan(4);
  });
});

describe("sleep regularity for night-only wear (SCORING_VERSION 44)", () => {
  it("with the band off by day for 8 days, the SRI and Sleep Performance are unchanged (version 43: those days dropped out, and the SRI moved)", async () => {
    const copy = await copyDb(db);
    const mains = await rows<{ day: string; s: number; e: number }>(
      copy,
      sql`select day::text as day, start_ts s, end_ts e from sleep_sessions where user_id = ${USER} and is_main and day between ${dayAt(99)} and ${dayAt(108)} order by day`,
    );
    // Off from 30 minutes after waking to 30 minutes before the next sleep: about 8.5 h of wear a day, under 720 minutes.
    for (let k = 0; k + 1 < mains.length; k++) {
      await mergeSamples(copy, "hr", USER, { start: Number(mains[k].e) + 1800, end: Number(mains[k + 1].s) - 1800 }, new Map(), "replace");
    }
    const dirty = Array.from({ length: 12 }, (_, k) => dayAt(98 + k));
    for (const day of dirty) await copy.execute(sql`insert into intraday_dirty (user_id, day) values (${USER}, ${day}) on conflict do nothing`);
    await recompute(copy, OPTS);
    const worn = await rows<{ m: number }>(copy, sql`select ((strain->>'hrMinutesAm')::int + (strain->>'hrMinutesPm')::int) m from daily_scores where user_id = ${USER} and day between ${dayAt(101)} and ${dayAt(106)}`);
    for (const w of worn) expect(w.m).toBeLessThan(720);
    for (let i = 101; i <= 110; i++) {
      const before = js<SleepRow>("sleep", dayAt(i));
      const after = await json<SleepRow>(copy, "sleep", dayAt(i));
      expect(after.sri).not.toBeNull();
      expect(after.sri).toBe(before.sri);
      expect(after.performance).toBe(before.performance);
    }
  });
});

describe("a night spent awake (SCORING_VERSION 25)", () => {
  type Sleep = SleepRow & { awakeAllNight: boolean };
  const sleepOf = async (d: Db, day: string) => (await rows<{ s: Sleep }>(d, sql`select sleep s from daily_scores where user_id = ${USER} and day = ${day}`))[0].s;
  const recoveryOf = async (d: Db, day: string) => (await rows<{ r: RecoveryRow }>(d, sql`select recovery r from daily_scores where user_id = ${USER} and day = ${day}`))[0].r;

  it("no seed day is a night spent awake; nights without a session (band off) stay out of the ledger", () => {
    let unworn = 0;
    for (const day of allDays) {
      const s = js<Sleep>("sleep", day);
      expect(s.awakeAllNight).toBe(false);
      if (!s.main) {
        unworn++;
        expect(s.creditedMin).toBeNull();
      }
    }
    expect(unworn).toBeGreaterThan(0);
  });

  /** A copy where wake day `i` has no sleep session; `awake` also writes up-and-about HR and steps over 00:00–06:00. */
  async function withoutNight(i: number, awake: boolean) {
    const copy = await copyDb(db);
    const day = dayAt(i);
    const [main] = await rows<{ id: string }>(copy, sql`select id from sleep_sessions where user_id = ${USER} and is_main and day = ${day}`);
    await copy.execute(sql`delete from sleep_segments where user_id = ${USER} and session_id = ${main.id}`);
    await copy.execute(sql`delete from sleep_sessions where user_id = ${USER} and id = ${main.id}`);
    if (awake) {
      const mid = localMidnight(day, TZ);
      const rhr = Number(metrics.get(dayAt(i - 1))!.rhr_bpm);
      const hr = new Map<number, number>();
      for (let t = mid; t < mid + 6 * 3600; t += 30) hr.set(t, Math.round(rhr + 14 + 3 * Math.sin(t / 600)));
      await mergeSamples(copy, "hr", USER, { start: mid, end: mid + 6 * 3600 }, hr, "replace");
      const steps = new Map<number, number>();
      for (let t = mid + 600; t < mid + 6 * 3600; t += 1200) steps.set(t, 40);
      await mergeSamples(copy, "steps", USER, { start: mid, end: mid + 6 * 3600 }, steps, "max");
    }
    await copy.execute(sql`insert into intraday_dirty (user_id, day) values (${USER}, ${dayAt(i - 1)}), (${USER}, ${day}), (${USER}, ${dayAt(i + 1)}) on conflict do nothing`);
    await recompute(copy, OPTS);
    return copy;
  }
  const I = 80;

  it("end to end: the band worn, HR up and steps overnight, with no session, count as a night without sleep", async () => {
    const copy = await withoutNight(I, true);
    const s = await sleepOf(copy, dayAt(I));
    expect(s).toMatchObject({ awakeAllNight: true, reason: "no_sleep", performance: null, main: null });
    // 0 plus yesterday's naps, and the ledger counts it.
    const naps = (await rows<{ m: number }>(copy, sql`select coalesce(sum(asleep_min), 0)::int m from sleep_sessions where user_id = ${USER} and not is_main and day = ${dayAt(I - 1)}`))[0].m;
    expect(s.creditedMin).toBe(naps);
    const series: [string, number | null][] = [];
    for (let k = 0; k <= I; k++) series.push([dayAt(k), (await sleepOf(copy, dayAt(k))).creditedMin]);
    expect(s.debtMin).toBe(ledger(series, s.needHours).magnitudeMin);
    const before = js<Sleep>("sleep", dayAt(I));
    expect(s.debtMin).toBeGreaterThan(before.debtMin + 150);
    // The need doesn't drop, Recovery has no HRV rather than no band, and the next night carries the debt.
    expect(s.needHours).toBe(before.needHours);
    expect((await recoveryOf(copy, dayAt(I))).reason).toBe("no_hrv_last_night");
    expect((await sleepOf(copy, dayAt(I + 1))).debtMin).toBeGreaterThan(js<Sleep>("sleep", dayAt(I + 1)).debtMin);
    // The Sleep screen: "Up all night" instead of "band not worn", and the debt shows that day.
    const vm = await getSleep(dayAt(I), ctxFor(copy));
    expect(vm.performance).toMatchObject({ value: null, reason: "no_sleep" });
    expect(reasonCopy("no_sleep")).toMatchObject({ short: "Up all night", long: "No sleep: you were up all night" });
    expect(vm.details.find((d) => d.key === "debt")!.metric.value).toBe(s.debtMin);
  });

  it("control: no session but sleeping-level HR (a night not yet synced, or missed) stays a night without data", async () => {
    const copy = await withoutNight(I, false);
    const s = await sleepOf(copy, dayAt(I));
    expect(s).toMatchObject({ awakeAllNight: false, reason: "band_not_worn", creditedMin: null });
    expect((await recoveryOf(copy, dayAt(I))).reason).toBe("band_not_worn");
  });
});

describe("ACWR on the seed (SCORING_VERSION 27)", () => {
  it("every training-load row says whether it is a light load; the seed's chronic load is always over 30, so none is", () => {
    let ratios = 0;
    for (const day of allDays) {
      const t = js<{ acwr: number | null; lightLoad: boolean }>("training_load", day);
      expect(t.lightLoad).toBe(false);
      if (t.acwr != null) ratios++;
    }
    expect(ratios).toBeGreaterThan(150);
  });
});

describe("the training-load ratio on the seed (SCORING_VERSION 45)", () => {
  const loadOf = (day: string) => js<{ load: number | null }>("training_load", day).load;

  it("every ratio is the EWMA acute ÷ chronic of the stored daily loads up to the day before (version 46)", () => {
    let checked = 0;
    for (const [i, day] of allDays.entries()) {
      const acwr = js<{ acwr: number | null }>("training_load", day).acwr;
      if (acwr == null) continue;
      const r = dayRatio(ewmaLoads(allDays.slice(0, i).map((d) => ({ day: d, load: loadOf(d) }))));
      expect(r, day).not.toBe("light");
      expect(acwr, day).toBeCloseTo((r as { ratio: number }).ratio, 9);
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
  });

  it("the return to training after the seed's illness never reads building fast or spiking (version 44: 9 days building fast)", () => {
    const { end } = SCENARIO.illness;
    for (let i = end + 1; i <= end + 28; i++) {
      const acwr = js<{ acwr: number | null }>("training_load", dayAt(i)).acwr;
      expect(acwr == null || acwr < 1.3, `${dayAt(i)}: ${acwr}`).toBe(true);
    }
  });

  it("the seed's 3-week heavy block still reads building fast, then spiking", () => {
    const bands = allDays.map((d) => js<{ acwr: number | null }>("training_load", d).acwr).filter((a): a is number => a != null).map(acwrBand);
    expect(bands.filter((b) => b === "LOAD_SPIKING").length).toBeGreaterThanOrEqual(10);
    expect(bands.indexOf("LOAD_BUILDING_FAST")).toBeLessThan(bands.indexOf("LOAD_SPIKING"));
  });
});

describe("training load from complete, seen days on the seed (SCORING_VERSION 46)", () => {
  type TL = { load: number | null; acwr: number | null; level: string; monotony: number | null; lightLoad: boolean };

  it("this morning reads the same ratio and level as tonight: the day's own load no longer counts until tomorrow", async () => {
    const i = allDays.length - 1;
    const last = allDays[i];
    const copy = await copyDb(db);
    const main = (await rows<{ e: number }>(copy, sql`select end_ts e from sleep_sessions where user_id = ${USER} and is_main and day = ${last}`))[0];
    // The morning: heart rate only up to 30 minutes after waking.
    await mergeSamples(copy, "hr", USER, { start: Number(main.e) + 1800, end: localMidnight(addDays(last, 1), TZ) }, new Map(), "replace");
    await copy.execute(sql`insert into intraday_dirty (user_id, day) values (${USER}, ${last}) on conflict do nothing`);
    await recompute(copy, OPTS);
    const morning = await json<TL & { [k: string]: unknown }>(copy, "training_load", last);
    const evening = js<TL>("training_load", last);
    expect(js<{ trimp: number }>("strain", last).trimp).toBeGreaterThan((await json<{ trimp: number | null }>(copy, "strain", last)).trimp ?? 0);
    expect({ acwr: morning.acwr, level: morning.level, monotony: morning.monotony, lightLoad: morning.lightLoad }).toEqual({
      acwr: evening.acwr,
      level: evening.level,
      monotony: evening.monotony,
      lightLoad: evening.lightLoad,
    });
  });

  it("Strain Target caps on the row's own ratio (through yesterday): capped exactly when it is over 1.3", () => {
    let targets = 0;
    for (const day of allDays) {
      const t = js<StrainTargetRow>("strain_target", day);
      if (t.reason !== null) continue;
      targets++;
      const acwr = js<TL>("training_load", day).acwr;
      expect(t.acwrRule === "capped", day).toBe(acwr != null && acwr > 1.3);
    }
    expect(targets).toBeGreaterThan(100);
  });

  it("a week worn only in bed: those days are unknown (version 45: rest days), and the ratio stays near the fully worn one", async () => {
    const copy = await copyDb(db);
    const mains = await rows<{ day: string; s: number; e: number }>(
      copy,
      sql`select day::text as day, start_ts s, end_ts e from sleep_sessions where user_id = ${USER} and is_main and day between ${dayAt(99)} and ${dayAt(108)} order by day`,
    );
    // Off from 15 minutes after waking to 15 minutes before the next sleep, for 7 days.
    for (let k = 0; k + 1 < mains.length && k < 8; k++) {
      await mergeSamples(copy, "hr", USER, { start: Number(mains[k].e) + 900, end: Number(mains[k + 1].s) - 900 }, new Map(), "replace");
    }
    for (let k = 0; k < 12; k++) await copy.execute(sql`insert into intraday_dirty (user_id, day) values (${USER}, ${dayAt(98 + k)}) on conflict do nothing`);
    await recompute(copy, OPTS);
    for (let i = 101; i <= 106; i++) {
      expect((await json<{ hrCount: number }>(copy, "strain", dayAt(i))).hrCount, dayAt(i)).toBeGreaterThan(0);
      expect((await json<TL>(copy, "training_load", dayAt(i))).load, dayAt(i)).toBeNull();
    }
    let worst = 0;
    for (let i = 102; i <= 130; i++) {
      const a = (await json<TL>(copy, "training_load", dayAt(i))).acwr;
      const b = js<TL>("training_load", dayAt(i)).acwr;
      if (a != null && b != null) worst = Math.max(worst, Math.abs(a - b));
    }
    expect(worst).toBeLessThan(0.15); // 0.09
    // Version 45's rule on the same copy (any heart rate is a measured day, so these were rest days of about 0): up to 0.51 off.
    const oldLoads: { day: string; load: number | null }[] = [];
    for (const d of allDays) {
      const st = await json<{ trimp: number | null; hrCount: number }>(copy, "strain", d);
      oldLoads.push({ day: d, load: st.trimp ?? (st.hrCount > 0 ? 0 : null) });
    }
    let worstOld = 0;
    for (let i = 102; i <= 130; i++) {
      const r = dayRatio(ewmaLoads(oldLoads.slice(0, i)));
      const b = js<TL>("training_load", dayAt(i)).acwr;
      if (r !== "light" && b != null) worstOld = Math.max(worstOld, Math.abs(r.ratio - b));
    }
    expect(worstOld).toBeGreaterThan(0.3);
  });
});

describe("Strain Target's starter session on the seed (SCORING_VERSION 48)", () => {
  it("the seed trains (typical session about 118): no day is on the starter", () => {
    let targets = 0;
    for (const day of allDays) {
      const t = js<StrainTargetRow>("strain_target", day);
      if (t.reason !== null) continue;
      targets++;
      expect(t.starter, day).toBe(false);
    }
    expect(targets).toBeGreaterThan(100);
  });

  it("the same days for someone whose heart rate never reaches zone 1: a starter target every day (version 47: calibrating)", async () => {
    // A max HR of 400 puts zone 1 (50 % of reserve) above 220 bpm, so every day's TRIMP is 0.
    const flat = await seeded([NOW], { compute: false });
    await recompute(flat, { ...OPTS, profile: { ...PROFILE, maxHr: 400 } });
    let targets = 0;
    let calibrating = 0;
    for (const day of allDays.slice(14)) {
      const st = await json<{ trimp: number | null; hrCount: number }>(flat, "strain", day);
      if (st.hrCount > 0) expect(st.trimp ?? 0, day).toBe(0);
      const t = await json<StrainTargetRow>(flat, "strain_target", day);
      if (t.reason === "calibrating") calibrating++;
      if (t.reason !== null) continue;
      targets++;
      expect(t, day).toMatchObject({ starter: true, base: loadToStrain(strainTargetConfig.starterSession) });
      expect(t.acwrRule, day).not.toBe("returning");
    }
    // Every day with a Recovery has a target; version 47 had none (a typical session of 0).
    expect(targets).toBeGreaterThan(140);
    expect(calibrating).toBe(0);
  });
});

describe("Fitness level by exact age on the seed (SCORING_VERSION 49)", () => {
  type Fit = { reason: null; vo2max: number; age: number; percentile: number; category: string } | { reason: string };

  it("the stored percentile is the one for the exact age", () => {
    let n = 0;
    for (const day of allDays) {
      const f = js<Fit>("fitness", day);
      if (f.reason !== null) continue;
      n++;
      expect(f.percentile, day).toBeCloseTo(vo2maxPercentile(f.vo2max, f.age, PROFILE.sex), 10);
    }
    expect(n).toBeGreaterThan(150);
  });

  it("turning 40 mid-seed moves it smoothly, not by a decade's step (version 48: 14.8 points that day)", async () => {
    const older = await seeded([NOW], { compute: false });
    const birthDate = `${Number(dayAt(90).slice(0, 4)) - 40}${dayAt(90).slice(4)}`;
    await recompute(older, { ...OPTS, profile: { ...PROFILE, birthDate } });
    let prev: { vo2max: number; percentile: number } | null = null;
    let worst = 0;
    let crossed = false;
    for (const day of allDays) {
      const f = await json<Fit>(older, "fitness", day);
      if (f.reason !== null) continue;
      if (f.age >= 40 && prev && !crossed) crossed = true;
      if (prev && prev.vo2max === f.vo2max) worst = Math.max(worst, Math.abs(f.percentile - prev.percentile));
      prev = f;
    }
    expect(crossed).toBe(true);
    expect(worst).toBeLessThan(1);
  });
});

describe("a lasting rise in daytime HR on the seed (SCORING_VERSION 50)", () => {
  type Stress = { highMin: number; referenceHr: number | null };
  /** A copy of the seed with awake HR raised by 15 bpm from day 100 on, recomputed with the given release. */
  async function raised(release: number) {
    const copy = await copyDb(db);
    const mains = await rows<{ s: number; e: number }>(copy, sql`select start_ts s, end_ts e from sleep_sessions where user_id = ${USER} and is_main and day >= ${dayAt(99)} order by day`);
    for (let k = 0; k + 1 < mains.length; k++) {
      const win = { start: Number(mains[k].e) + 60, end: Number(mains[k + 1].s) - 60 };
      const hr = await readHr(copy, USER, win.start, win.end);
      await mergeSamples(copy, "hr", USER, win, new Map(hr.map((x) => [x.ts, x.bpm + 15])), "replace");
    }
    for (let i = 99; i < allDays.length; i++) await copy.execute(sql`insert into intraday_dirty (user_id, day) values (${USER}, ${dayAt(i)}) on conflict do nothing`);
    const keep = stillGateConfig.release;
    stillGateConfig.release = release;
    try {
      await recompute(copy, OPTS);
    } finally {
      stillGateConfig.release = keep;
    }
    return copy;
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

  it("+15 bpm from day 100: the stress reference follows within weeks and high minutes settle (version 49: still 15 bpm low at the end)", async () => {
    const now = await raised(stillGateConfig.release);
    const v49 = await raised(Infinity);
    const ref = async (d: Db, i: number) => (await json<Stress>(d, "stress", dayAt(i))).referenceHr!;
    const high = async (d: Db, from: number, to: number) => median(await Promise.all(Array.from({ length: to - from }, async (_, k) => (await json<Stress>(d, "stress", dayAt(from + k))).highMin)));
    const before = js<Stress>("stress", dayAt(99)).referenceHr!;
    const usual = median(allDays.slice(70, 99).map((day) => js<Stress>("stress", day).highMin));
    // Measured: the reference rose 14.1 of the 15 bpm by the last day (version 49: 2.8, gated out on most days).
    expect((await ref(now, allDays.length - 1)) - before).toBeGreaterThan(12);
    expect((await ref(v49, allDays.length - 1)) - before).toBeLessThan(5);
    // Median high minutes over the last 7 weeks: 8 (version 49: 42; the seed's usual before the rise, 36).
    expect(await high(now, 130, allDays.length)).toBeLessThanOrEqual(usual);
    expect(await high(v49, 130, allDays.length)).toBeGreaterThan((await high(now, 130, allDays.length)) + 20);
  });
});

describe("an atypical first week on the seed (SCORING_VERSION 52)", () => {
  type Stress = { referenceHr: number | null };
  /** A copy of the seed with awake HR raised by 20 bpm on its first 5 days (a new user who starts while ill). */
  async function sickStart(cleanDays: number) {
    const copy = await copyDb(db);
    const mains = await rows<{ s: number; e: number }>(copy, sql`select start_ts s, end_ts e from sleep_sessions where user_id = ${USER} and is_main and day <= ${dayAt(5)} order by day`);
    for (let k = 0; k + 1 < mains.length; k++) {
      const win = { start: Number(mains[k].e) + 60, end: Number(mains[k + 1].s) - 60 };
      const hr = await readHr(copy, USER, win.start, win.end);
      await mergeSamples(copy, "hr", USER, win, new Map(hr.map((x) => [x.ts, x.bpm + 20])), "replace");
    }
    for (let i = 0; i < allDays.length; i++) await copy.execute(sql`insert into intraday_dirty (user_id, day) values (${USER}, ${dayAt(i)}) on conflict do nothing`);
    const keep = earlyCleanConfig.days;
    earlyCleanConfig.days = cleanDays;
    try {
      await recompute(copy, OPTS);
    } finally {
      earlyCleanConfig.days = keep;
    }
    return copy;
  }

  it("+20 bpm on the first 5 days: by day 14 the stress reference is the seed's own (version 51: still far above)", async () => {
    const now = await sickStart(earlyCleanConfig.days);
    const v51 = await sickStart(0);
    const ref = async (d: Db, i: number) => (await json<Stress>(d, "stress", dayAt(i))).referenceHr!;
    const seed = js<Stress>("stress", dayAt(14)).referenceHr!;
    // Measured: day 14 74.5 against the seed's 73.9 (version 51: 83.0); day 28 74.5 against 74.2 (version 51: 78.8).
    expect(Math.abs((await ref(now, 14)) - seed)).toBeLessThan(2);
    expect((await ref(v51, 14)) - seed).toBeGreaterThan(8);
    expect(Math.abs((await ref(now, 28)) - js<Stress>("stress", dayAt(28)).referenceHr!)).toBeLessThan(1.5);
    expect((await ref(v51, 28)) - js<Stress>("stress", dayAt(28)).referenceHr!).toBeGreaterThan(3);
  });
});

describe("one workout per session on the seed (SCORING_VERSION 51)", () => {
  it("an app's Health Connect copy of a seeded strength session changes no score: one activity, the same strength minutes", async () => {
    const copy = await copyDb(db);
    // The last seeded strength session, copied as an app writes it: 40 s earlier, 20 s longer, no calories.
    const [w] = await rows<{ id: string; day: string; s: number; e: number }>(
      copy,
      sql`select id, day::text as day, start_ts s, end_ts e from exercises where user_id = ${USER} and type = 'STRENGTH_TRAINING' order by start_ts desc limit 1`,
    );
    await copy.execute(
      sql`insert into exercises (user_id, id, day, start_ts, end_ts, type, name, calories, source) values (${USER}, 'hc-copy', ${w.day}, ${Number(w.s) - 40}, ${Number(w.e) + 20}, 'STRENGTH_TRAINING', 'Strength training', null, 'HEALTH_CONNECT')`,
    );
    await copy.execute(sql`insert into intraday_dirty (user_id, day) values (${USER}, ${w.day}) on conflict do nothing`);
    await recompute(copy, OPTS);
    const cols = sql`activities, healthspan, strain, stress, energy_bank`;
    const before = await rows<Record<string, unknown>>(db, sql`select day::text as day, ${cols} from daily_scores where user_id = ${USER} and day >= ${w.day} order by day`);
    const after = await rows<Record<string, unknown>>(copy, sql`select day::text as day, ${cols} from daily_scores where user_id = ${USER} and day >= ${w.day} order by day`);
    expect(after).toEqual(before);
    const acts = (after[0].activities as { id: string }[]).map((a) => a.id);
    expect(acts).toContain(w.id);
    expect(acts).not.toContain("hc-copy");
  });
});

describe("monotony on the seed (SCORING_VERSION 47)", () => {
  it("is still stored on the no-rest weeks, under the cap, and those days' levels come from other signals", () => {
    const tl = allDays.map((d) => js<{ level: string; monotony: number | null }>("training_load", d));
    const high = tl.filter((t) => t.monotony != null && t.monotony >= 2);
    // Measured: 17 days, at most 4.5; 11 strained, 4 run down and 2 balanced (ramping down with one good signal), so
    // dropping the "watch" moved no seed level (GOLDEN[47]: training_load unchanged).
    expect(high.length).toBeGreaterThanOrEqual(10);
    expect(Math.max(...high.map((t) => t.monotony!))).toBeLessThan(monotonyMax);
    expect(high.filter((t) => t.level === "strained" || t.level === "rundown").length).toBeGreaterThanOrEqual(10);
  });
});

describe("the illness hold on the seed (SCORING_VERSION 30)", () => {
  it("holds nights only inside the seed's illness, each after an illness-ward night, and never more than 21 in a row", () => {
    const held = allDays.filter((day) => js<RecoveryRow>("recovery", day).heldBaseline);
    expect(held.length).toBeGreaterThan(0);
    for (const day of held) {
      // A held night continues a run: the night before was illness-ward too, so it scored low.
      const before = js<RecoveryRow>("recovery", addDays(day, -1)).value;
      expect(before == null || before < 50, `${day}: the night before read ${before}`).toBe(true);
    }
    let run = 0;
    for (const day of allDays) {
      run = js<RecoveryRow>("recovery", day).heldBaseline ? run + 1 : 0;
      expect(run).toBeLessThanOrEqual(21);
    }
    // Only the seed's illness nights are held.
    const { start, end } = SCENARIO.illness;
    for (const day of held) expect(day >= dayAt(start) && day <= dayAt(end), day).toBe(true);
  });
});

describe("a main sleep without stages (SCORING_VERSION 31)", () => {
  type Sleep = SleepRow & { restorative: string | null };
  it("every seed night is staged, so every scored night's restorative part is measured", () => {
    for (const day of allDays) {
      const sl = js<Sleep>("sleep", day);
      expect(sl.restorative).toBe(sl.performance == null ? null : "measured");
    }
  });

  it("end to end: unstage one night; it scores near its staged value with your usual restorative sleep, and the centre barely moves", async () => {
    const I = 100;
    const copy = await copyDb(db);
    const [main] = await rows<{ id: string }>(copy, sql`select id from sleep_sessions where user_id = ${USER} and is_main and day = ${dayAt(I)}`);
    await copy.execute(sql`delete from sleep_segments where user_id = ${USER} and session_id = ${main.id}`);
    await copy.execute(sql`update sleep_sessions set stages_status = 'FAILED', deep_min = null, light_min = null, rem_min = null where user_id = ${USER} and id = ${main.id}`);
    await copy.execute(sql`insert into intraday_dirty (user_id, day) values (${USER}, ${dayAt(I)}), (${USER}, ${dayAt(I + 1)}) on conflict do nothing`);
    await recompute(copy, OPTS);
    const sleepOf = async (day: string) => (await rows<{ s: Sleep }>(copy, sql`select sleep s from daily_scores where user_id = ${USER} and day = ${day}`))[0].s;
    const recOf = async (day: string) => (await rows<{ r: RecoveryRow }>(copy, sql`select recovery r from daily_scores where user_id = ${USER} and day = ${day}`))[0].r;
    const before = js<Sleep>("sleep", dayAt(I));
    const after = await sleepOf(dayAt(I));
    expect(after.main!.staged).toBe(false);
    expect(after.restorative).toBe("usual");
    expect(Math.abs(after.performance! - before.performance!)).toBeLessThan(5);
    // Version 30's rule (deep and REM as 0) on the same night lost far more.
    const old = rest(after.main!.asleepMin * 60, after.main!.efficiency, 0, 0, after.needHours, after.consistency == null ? null : after.consistency / 100)!;
    expect(before.performance! - old).toBeGreaterThan(10);
    // The next day's sleep centre (Recovery's) hardly moves.
    const centre = (r: RecoveryRow) => (r.inputs as { sleepCentre: number }).sleepCentre;
    expect(Math.abs(centre(await recOf(dayAt(I + 1))) - centre(js<RecoveryRow>("recovery", dayAt(I + 1))))).toBeLessThan(0.01);
  });
});

describe("the robust first week (SCORING_VERSION 32)", () => {
  it("end to end: a 180 ms glitch on night 3 leaves Recovery's HRV z spread over days 8–30 within 15 % of the seed's", async () => {
    const copy = await copyDb(db);
    await copy.update(dailyMetrics).set({ hrvMs: 180 }).where(and(eq(dailyMetrics.userId, USER), eq(dailyMetrics.day, dayAt(2))));
    await copy.execute(sql`insert into intraday_dirty (user_id, day) values (${USER}, ${dayAt(2)}) on conflict do nothing`);
    await recompute(copy, OPTS);
    const sd = (xs: number[]) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
    };
    const zs = async (d: Db) =>
      (await rows<{ z: number | null }>(d, sql`select (recovery->>'hrvZ')::float8 z from daily_scores where user_id = ${USER} and day between ${dayAt(7)} and ${dayAt(29)} order by day`))
        .map((r) => r.z)
        .filter((z): z is number => z != null);
    const seed = sd(await zs(db));
    const glitched = sd(await zs(copy));
    // Version 31 folded the glitch into the young spread: the same z spread fell by more than a third.
    expect(glitched / seed).toBeGreaterThan(0.85);
  });
});

describe("a lasting step restarts the baselines (SCORING_VERSION 33)", () => {
  it("end to end: resting HR 18 bpm lower from day 120 is followed within 14 days by Recovery and the Health Monitor", async () => {
    const copy = await copyDb(db);
    // A beta-blocker from day 120 on lowers both resting readings (version 35: Recovery scores the sleeping one).
    // Google's resting-HR ranges are cleared, so the Monitor uses Pulse's baseline.
    await copy.execute(sql`update daily_metrics set rhr_bpm = rhr_bpm - 18, non_rem_hr_bpm = non_rem_hr_bpm - 18 where user_id = ${USER} and day >= ${dayAt(120)}`);
    await copy.execute(sql`update daily_metrics set rhr_range_low = null, rhr_range_high = null where user_id = ${USER}`);
    await copy.execute(sql`insert into intraday_dirty (user_id, day) select ${USER}, day from daily_metrics where user_id = ${USER} and day >= ${dayAt(118)} on conflict do nothing`);
    await recompute(copy, OPTS);
    const at = async (i: number) =>
      (await rows<{ r: RecoveryRow; h: HealthMonitorRow; rhr: number }>(
        copy,
        sql`select s.recovery r, s.health_monitor h, (s.recovery->'inputs'->>'rhr')::float8 rhr from daily_scores s join daily_metrics m on m.user_id = s.user_id and m.day = s.day where s.user_id = ${USER} and s.day = ${dayAt(i)}`,
      ))[0];
    const before = (js<RecoveryRow>("recovery", dayAt(119)).baselines as { rhr: { mean: number } }).rhr.mean;
    const later = await at(134);
    const centre = (later.r.baselines as { rhr: { mean: number } }).rhr.mean;
    // Version 32 rejected every night and stayed at the old level; now the baseline sits at the new one.
    expect(centre).toBeLessThan(before - 15);
    expect(Math.abs(centre - (before - 18))).toBeLessThan(3);
    // The Monitor's resting-HR range holds the new values again.
    const hm = later.h as Extract<HealthMonitorRow, { reason: null }>;
    const rhrVital = hm.vitals.find((v) => v.key === "restingHr")!;
    expect(rhrVital.rangeSource).toBe("pulse");
    expect(rhrVital.range!.low).toBeLessThanOrEqual(later.rhr);
    expect(rhrVital.range!.high).toBeGreaterThanOrEqual(later.rhr);
  });
});

describe("count my data from (SCORING_VERSION 34)", () => {
  it("scores start at the date as if earlier days didn't exist, and clearing it restores every score exactly", async () => {
    const copy = await copyDb(db);
    const from = dayAt(60);
    await recompute(copy, { ...OPTS, dataFrom: from });
    const days = (await rows<{ d: string }>(copy, sql`select to_char(day, 'YYYY-MM-DD') d from daily_scores where user_id = ${USER} order by day`)).map((r) => r.d);
    expect(days[0]).toBe(from);
    expect(days).toHaveLength(allDays.length - 60);
    // Recovery starts over: its first week calibrates again, as on day 1.
    for (let i = 60; i < 67; i++) expect((await rows<{ r: RecoveryRow }>(copy, sql`select recovery r from daily_scores where user_id = ${USER} and day = ${dayAt(i)}`))[0].r).toMatchObject({ value: null, reason: "calibrating" });
    // Reports only cover days from the date; intraday series start there too.
    const reportStarts = (await rows<{ s: string }>(copy, sql`select data->>'start' s from reports where user_id = ${USER}`)).map((r) => r.s);
    expect(reportStarts.every((s) => s >= addDays(from, -31))).toBe(true);
    expect((await rows<{ n: number }>(copy, sql`select count(*)::int n from intraday_series where user_id = ${USER} and day < ${from}`))[0].n).toBe(0);
    // The stored data is untouched.
    expect((await rows<{ n: number }>(copy, sql`select count(*)::int n from daily_metrics where user_id = ${USER} and day < ${from}`))[0].n).toBe(60);
    // Clearing the date brings back the full history, scored exactly as before.
    await recompute(copy, OPTS);
    expect(await dump(copy, "daily_scores", "day")).toBe(await dump(db, "daily_scores", "day"));
    expect(await dump(copy, "reports", "period")).toBe(await dump(db, "reports", "period"));
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
      // Since version 30 a night held by the illness hold stays out of the centre.
      if (inputs.sleepPerf != null && !js<RecoveryRow>("recovery", day).heldBaseline) prior.push(inputs.sleepPerf);
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

  it("Strain reads Google's daily resting HR; Recovery its sleeping HR once established (version 35), Google's before", () => {
    const rhr = metric(dayAt(120), "rhr_bpm");
    expect(js<Stage1Day>("strain", dayAt(120))).toMatchObject({ restingHr: rhr, restingHrSource: "daily" });
    expect(js<RecoveryRow>("recovery", dayAt(120)).inputs).toMatchObject({ rhr: metric(dayAt(120), "non_rem_hr_bpm"), rhrSource: "sleep", dailyRhr: rhr });
    // Until the sleeping-HR baseline is trusted (14 nights), Google's daily value against its own baseline.
    const early = js<RecoveryRow>("recovery", dayAt(10)).inputs;
    expect(early).toMatchObject({ rhr: metric(dayAt(10), "rhr_bpm"), rhrSource: "daily", sleepHr: metric(dayAt(10), "non_rem_hr_bpm") });
  });

  it("Recovery never scores or folds Pulse's session estimate (version 39, audit R10)", () => {
    let scored = 0;
    for (const d of allDays) {
      const r = js<RecoveryRow>("recovery", d);
      if (r.value == null) continue;
      scored++;
      const google = metrics.get(d)?.rhr_bpm ?? null;
      // The daily column is Google's value only, and the scored value is one of the two real series.
      expect(r.inputs.dailyRhr ?? null, d).toBe(google);
      expect([null, "sleep", "daily"]).toContain(r.inputs.rhrSource ?? null);
      if (r.inputs.rhrSource === "sleep") expect(r.inputs.rhr).toBe(r.inputs.sleepHr);
      else if (r.inputs.rhrSource === "daily") expect(r.inputs.rhr).toBe(google);
      else expect(r.inputs.rhr).toBeNull();
    }
    // The seed always has Google's daily value, so this guards the columns; restingPair.test.ts covers the missing case.
    expect(scored).toBeGreaterThan(150);
  });

  it("skin temperature: nightly − Google's baseline; Health Monitor takes Google's ranges (resting HR's only for Google's own value)", () => {
    const d = dayAt(120);
    const dev = (metric(d, "nightly_temp_c") as number) - (metric(d, "temp_baseline_c") as number);
    expect(js<RecoveryRow>("recovery", d).inputs.skinTempDev).toBeCloseTo(dev, 9);
    const hm = js<HealthMonitorRow>("health_monitor", d);
    if (hm.reason !== null) throw new Error("no health monitor");
    const by = Object.fromEntries(hm.vitals.map((v) => [v.key, v]));
    // Version 35: the Monitor scores the sleeping HR here, which Google's resting-HR range doesn't describe.
    expect(js<RecoveryRow>("recovery", d).inputs.rhrSource).toBe("sleep");
    expect(by.restingHr).toMatchObject({ rangeSource: "pulse", value: metric(d, "non_rem_hr_bpm") });
    // Before the sleeping-HR baseline is trusted, a night with Google's range and value keeps that range.
    const g = allDays.find((x) => metric(x, "rhr_range_low") != null && js<RecoveryRow>("recovery", x).inputs.rhrSource === "daily")!;
    expect(g).toBeDefined();
    const early = js<HealthMonitorRow>("health_monitor", g);
    if (early.reason !== null) throw new Error("no health monitor");
    expect(early.vitals.find((v) => v.key === "restingHr")).toMatchObject({ rangeSource: "google", range: { low: metric(g, "rhr_range_low"), high: metric(g, "rhr_range_high") } });
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
      // Version 37: the shown score's composite is scaled by missingInputScale(its terms); the body-only one by the same
      // for its terms with sleep left out on purpose (factor 1 when every body signal is there).
      const present = r.terms.map((t) => (t === "skinTemp" ? "skin" : t)) as RecoveryTerm[];
      const body = present.filter((t) => t !== "sleep");
      const fShown = missingInputScale(present);
      const fBody = missingInputScale(body, ["sleep"]);
      const z = (logisticZ0 - Math.log(100 / r.value - 1) / logisticK) / fShown; // the plain weighted average
      if (!r.terms.includes("sleep")) {
        if (r.value > 0.5 && r.value < 99.5) expect(r.withoutSleep!).toBeCloseTo(logisticScore(z * fBody), 6);
        continue;
      }
      // Rebuild: the composite, minus the sleep term, renormalised over the remaining weights.
      const total = r.terms.reduce((a, t) => a + W[t], 0);
      const zSleep = (r.inputs.sleepPerf! - r.inputs.sleepCentre!) / sleepPerfScale;
      const zBody = (z * total - zSleep * wSleep) / (total - wSleep);
      if (r.value > 0.5 && r.value < 99.5) {
        expect(r.withoutSleep!).toBeCloseTo(logisticScore(zBody * fBody), 6);
        checked++;
      }
      // The composite is a weighted average: with every input (both factors 1) the shown score sits above the body-only
      // one exactly when the sleep term beat the other terms' average (not merely when sleep beat your usual night).
      const gap = r.value - r.withoutSleep!;
      if (fShown === 1 && fBody === 1 && Math.abs(zSleep - zBody) > 1e-6 && r.value > 0.5 && r.value < 99.5) expect(Math.sign(gap)).toBe(Math.sign(zSleep - zBody));
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

describe("Stress on the seed (SCORING_VERSION 21)", () => {
  type S1 = { restingHr: number; maxHr: number };
  const series = async (kind: string, day: string) =>
    (await rows<{ data: (number | null)[] }>(db, sql`select data from intraday_series where user_id = ${USER} and day = ${day} and kind = ${kind}`))[0]?.data ?? [];

  it("the 30 minutes after each logged workout are not still minutes, nor is any minute at ≥ 40 % of reserve", async () => {
    const exs = await rows<{ day: string; end_ts: number }>(db, sql`select day, end_ts from exercises where user_id = ${USER} order by start_ts`);
    expect(exs.length).toBeGreaterThan(20);
    let tails = 0, hot = 0;
    for (const e of exs.filter((_, i) => i % 5 === 0)) {
      const day = String(e.day).slice(0, 10);
      const lo = localMidnight(day, TZ);
      const still = await series("still_hr", day);
      const end = Math.ceil((Number(e.end_ts) - lo) / 60);
      for (let m = end; m < Math.min(still.length, end + 30); m++) {
        expect(still[m]).toBeNull();
        tails++;
      }
      // Exertion: any minute whose mean HR reaches 40 % of reserve is never still.
      const s1 = js<S1>("strain", day);
      const threshold = s1.restingHr + 0.4 * (s1.maxHr - s1.restingHr);
      const hr = await series("hr", day);
      hr.forEach((v, m) => {
        if (v != null && v >= threshold) {
          expect(still[m] ?? null).toBeNull();
          hot++;
        }
      });
    }
    expect(tails).toBeGreaterThan(100);
    expect(hot).toBeGreaterThan(0);
  });

  it("the illness week doesn't move the daytime reference (a day > 2σ above it is not folded)", () => {
    type St = { referenceHr: number | null };
    const ref = (i: number) => js<St>("stress", dayAt(i)).referenceHr!;
    const before = ref(117);
    for (let i = 118; i <= 131; i++) expect(Math.abs(ref(i) - before)).toBeLessThan(1);
  });
});

describe("SpO2 on the seed (SCORING_VERSION 22)", () => {
  it("ordinary nights are not flagged; the illness peak still is", () => {
    const spo2 = (d: string) => js<HealthMonitorRow>("health_monitor", d);
    const statusOf = (d: string) => {
      const h = spo2(d);
      return h.reason === null ? h.vitals.find((v) => v.key === "spo2")!.status : null;
    };
    const outside = allDays.filter((d, i) => (i < 118 || i > 125) && statusOf(d) === "low");
    expect(outside.length).toBeLessThanOrEqual(2);
    expect([119, 120, 121, 122].some((i) => statusOf(dayAt(i)) === "low")).toBe(true);
  });
});

describe("the illness signal's workout context on the seed (SCORING_VERSION 23)", () => {
  type S1 = { trimp: number | null };
  const loads = () => allDays.map((d) => js<S1>("strain", d)?.trimp ?? null);

  it("ordinary training doesn't count as hard: none of the seed's days reach 2 Day Strain points over its typical session", () => {
    // The seed's hardest days (its training block's double sessions) sit at most about 1.8 points above.
    const l = loads();
    let training = 0;
    for (let i = 28; i < l.length; i++) {
      const prior = l.slice(i - 28, i).filter((v): v is number => v != null);
      const session = typicalSession(prior);
      if (l[i] == null || session == null) continue;
      if (l[i]! >= 0.3 * session) training++;
      expect(hardOrLateWorkout({ load: l[i], priorLoads: prior, workouts: [], bedtime: null })).toBe(false);
    }
    expect(training).toBeGreaterThan(40);
  });

  it("an illness-like night after a late workout reads 'suppressed' with the workout reason; after a rest day, 'raised'", async () => {
    const copy = await copyDb(db);
    // A seeded workout, moved to end an hour before that night's main sleep (a late session).
    const [ex] = await rows<{ id: string; day: string }>(copy, sql`select id, to_char(day, 'YYYY-MM-DD') as day from exercises where user_id = ${USER} and day between ${dayAt(60)} and ${dayAt(100)} order by start_ts limit 1`);
    const exDay = allDays.indexOf(ex.day);
    const [sleep] = await rows<{ s: number }>(copy, sql`select start_ts s from sleep_sessions where user_id = ${USER} and is_main and day = ${dayAt(exDay + 1)}`);
    await copy.execute(sql`update exercises set start_ts = ${Number(sleep.s) - 3600 - 45 * 60}, end_ts = ${Number(sleep.s) - 3600} where user_id = ${USER} and id = ${ex.id}`);
    // A rest day well away from it for the control.
    const l = loads();
    let rest = -1;
    for (let i = 40; i < 110; i++) if (Math.abs(i - exDay) > 3 && l[i] != null && l[i]! < 20) { rest = i; break; }
    const strain = async (i: number) => {
      const m = metrics.get(dayAt(i + 1))!;
      await copy.update(dailyMetrics).set({ rhrBpm: Number(m.rhr_bpm) + 12, nonRemHrBpm: Number(m.non_rem_hr_bpm) + 12, hrvMs: Number(m.hrv_ms) * 0.55, respBpm: Number(m.resp_bpm) + 2.5 }).where(and(eq(dailyMetrics.userId, USER), eq(dailyMetrics.day, dayAt(i + 1))));
      await copy.execute(sql`insert into intraday_dirty (user_id, day) values (${USER}, ${dayAt(i)}), (${USER}, ${dayAt(i + 1)}) on conflict do nothing`);
    };
    await strain(exDay);
    await strain(rest);
    await recompute(copy, OPTS);
    type Hm = { illness: { level: string; suppressedBy: string[] } };
    const ill = async (i: number) => (await rows<{ h: Hm }>(copy, sql`select health_monitor h from daily_scores where user_id = ${USER} and day = ${dayAt(i)}`))[0].h.illness;
    expect(await ill(exDay + 1)).toMatchObject({ level: "suppressed", suppressedBy: ["a hard or late workout"] });
    expect((await ill(rest + 1)).level).toBe("raised");
  });
});
