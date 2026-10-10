// Stage 2: folds every day, oldest first, over the daily rows and stage 1's cached results, then
// writes only the rows, series and reports whose JSON changed.
import { and, eq, gt, gte, inArray, lt, lte, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import { dailyScores, intradayDirty, intradaySeries, journalEntries, reports, sleepAwakenings, sleepSegments } from "../db/schema";
import { addDays } from "../time";
import { hrvCfg, respCfg, restingHRCfg, skinTempCfg, update } from "@/core/scoring/baselines";
import { journalImpact, journalImpactConfig, type JournalDay, type TagImpact } from "@/core/algorithms/journalImpact";
import { buildReport, periodBounds, reportPeriods } from "@/core/algorithms/reports";
import { BATCH_DAYS, type Data, groupBy, type Segment, sha, upsertSeries } from "./data";
import {
  type Cached,
  dayOf,
  forecastOf,
  type Inputs,
  newFold,
  recordOutcomes,
  scoreEnergyBank,
  scoreFitness,
  scoreHealthMonitor,
  scoreHealthspan,
  scorePlanner,
  scoreRecovery,
  scoreSleep,
  scoreStrainTarget,
  scoreStress,
  scoreTrainingLoad,
} from "./scores";
import {
  type JournalImpactRow,
  type PipelineOptions,
  type RecoveryRow,
  SCORING_VERSION,
  STAGE2_COLUMNS,
  type Stage1Activity,
  type Stage1Day,
  type Stage2Row,
} from "./types";

export async function stage2(db: Db, data: Data, opts: PipelineOptions) {
  const { userId, timeZone: tz } = opts;
  const { days } = data;
  const { inputs, journal, storedImpact } = await readInputs(db, userId);
  const stillHr = new Map<string, (number | null)[]>();
  const loadSeries = new Map<string, (number | null)[]>();
  Object.assign(inputs, { stillHr, loadSeries });

  const f = newFold();
  const out = new Map<string, Omit<Stage2Row, "journal_impact">>();
  // Stress and Energy Bank series go out in batches during the fold rather than all at the end, so memory
  // doesn't grow with history. They are idempotent upserts; a crash before the final commit leaves
  // intraday_dirty set, so the next run redoes everything.
  let pending: { day: string; stress: (number | null)[]; energy: (number | null)[] | null }[] = [];
  const flush = async () => {
    const batch = pending;
    pending = [];
    if (!batch.length) return;
    const series = batch.flatMap((p) => [
      { day: p.day, kind: "stress", data: p.stress },
      ...(p.energy ? [{ day: p.day, kind: "energy_bank", data: p.energy }] : []),
    ]);
    const noEnergy = batch.filter((p) => !p.energy).map((p) => p.day);
    const t = intradaySeries;
    await db.transaction(async (tx) => {
      await upsertSeries(tx, userId, series);
      if (noEnergy.length) await tx.delete(t).where(and(eq(t.userId, userId), eq(t.kind, "energy_bank"), inArray(t.day, noEnergy)));
    });
  };

  // Order matters: each scorer reads the fold as earlier scorers left it for today.
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    if (i % BATCH_DAYS === 0) {
      // The per-minute series the scorers read, a batch of days at a time: the scorers stay synchronous and memory
      // stays flat in history length.
      await flush();
      const batch = days.slice(i, i + BATCH_DAYS);
      stillHr.clear();
      loadSeries.clear();
      const t = intradaySeries;
      const rows = await db
        .select({ day: t.day, kind: t.kind, data: t.data })
        .from(t)
        .where(and(eq(t.userId, userId), inArray(t.kind, ["still_hr", "load"]), gte(t.day, batch[0]), lte(t.day, batch.at(-1)!)));
      for (const r of rows) (r.kind === "still_hr" ? stillHr : loadSeries).set(r.day, r.data as (number | null)[]);
    }
    const d = dayOf(data, inputs, day, opts);
    const sleep = scoreSleep(data, inputs, f, d, tz);
    const recovery = scoreRecovery(f, d, sleep);
    const trainingLoad = scoreTrainingLoad(f, d, recovery);
    const strainTarget = scoreStrainTarget(f, recovery);
    const planner = scorePlanner(f, d, sleep, tz);
    recovery.forecast = forecastOf(f, d, recovery, planner.plan, planner.tonightNeed);
    const stress = scoreStress(f, d, inputs);
    const energy = scoreEnergyBank(data, inputs, d, recovery, sleep, stress.minutes);
    pending.push({ day, stress: stress.series, energy: energy.curve });
    const healthMonitor = scoreHealthMonitor(data, f, d, inputs, recovery);
    const healthspan = scoreHealthspan(data, f, d, sleep, opts);
    const fitness = scoreFitness(f, d, opts);
    recordOutcomes(f, d, recovery, sleep, trainingLoad);
    out.set(day, {
      recovery,
      sleep,
      training_load: trainingLoad,
      strain_target: strainTarget,
      sleep_planner: planner.row,
      energy_bank: energy.row,
      stress: stress.row,
      health_monitor: healthMonitor,
      healthspan,
      fitness,
    });

    // Fold today's nightly values into the baselines (after scoring today), unless the night is held as part of an
    // illness-ward run (version 30): then the baselines stay as they were, staleness included.
    if (!recovery.heldBaseline) {
      f.hrvB = update(f.hrvB, recovery.inputs.hrv, hrvCfg);
      // Each resting-HR series folds into its own baseline (version 35).
      f.rhrB = update(f.rhrB, recovery.inputs.dailyRhr ?? null, restingHRCfg);
      f.sleepHrB = update(f.sleepHrB, recovery.inputs.sleepHr ?? null, restingHRCfg);
      f.respB = update(f.respB, recovery.inputs.resp, respCfg);
      f.skinB = update(f.skinB, d.dm?.nightlyTempC ?? null, skinTempCfg);
    }
    f.prevAcwr = trainingLoad.acwr;
  }
  await flush();

  // ── Journal impact: as of each day, memoised on its inputs ────────────────
  const entries: JournalDay[] = [...journal].map(([day, es]) => ({ day, tags: Object.fromEntries(es.map((e) => [e.tag, e.value])) }));
  const rows = new Map<string, Stage2Row>();
  const impactsAsOf = new Map<string, TagImpact[]>();
  for (const day of days) {
    const from = addDays(day, -90);
    const inWindow = entries.filter((e) => e.day >= from && e.day < day);
    const outWindow = f.outcomes.filter((o) => o.day > from && o.day <= day);
    // The method version is part of the key, so a new method recomputes results whose inputs did not change.
    const key = sha(JSON.stringify([journalImpactConfig.version, inWindow, outWindow]));
    const prior = storedImpact.get(day);
    const impacts = prior?.key === key ? prior.impacts : journalImpact(inWindow, outWindow, day);
    impactsAsOf.set(day, impacts);
    rows.set(day, { ...out.get(day)!, journal_impact: { key, impacts } });
  }

  // ── Writes ────────────────────────────────────────────────────────────────
  // Only rows whose version or JSON changed are updated (jsonb compares by value), so an unchanged run writes nothing.
  const ds = dailyScores;
  const cols = ["scoring_version", ...STAGE2_COLUMNS];
  const set = Object.fromEntries(cols.map((k) => [camel(k), sql.raw(`excluded.${k}`)]));
  const changed = sql.raw(`(${cols.map((k) => `daily_scores.${k}`)}) is distinct from (${cols.map((k) => `excluded.${k}`)})`);
  const scoreRows = days.map((day) => {
    const row = rows.get(day)!;
    return { userId, day, scoringVersion: SCORING_VERSION, ...Object.fromEntries(STAGE2_COLUMNS.map((k) => [camel(k), row[k]])) };
  });
  const periods = reportPeriods(f.reportRows);
  const reportRows = periods.map((period) => {
    const { end } = periodBounds(period);
    const asOf = end < data.last ? end : data.last;
    return { userId, period, data: buildReport(period, f.reportRows, impactsAsOf.get(asOf) ?? []) };
  });
  const rp = reports;
  const is = intradaySeries;
  await db.transaction(async (tx) => {
    for (let i = 0; i < scoreRows.length; i += 200) {
      await tx
        .insert(ds)
        .values(scoreRows.slice(i, i + 200))
        .onConflictDoUpdate({ target: [ds.userId, ds.day], set, setWhere: changed });
    }
    if (reportRows.length) {
      await tx
        .insert(rp)
        .values(reportRows)
        .onConflictDoUpdate({ target: [rp.userId, rp.period], set: { data: sql`excluded.data` }, setWhere: sql`reports.data is distinct from excluded.data` });
    }
    await tx.delete(rp).where(and(eq(rp.userId, userId), periods.length ? notInArray(rp.period, periods) : undefined));
    await tx.delete(ds).where(and(eq(ds.userId, userId), or(lt(ds.day, data.first), gt(ds.day, data.last))));
    await tx.delete(is).where(and(eq(is.userId, userId), or(lt(is.day, data.first), gt(is.day, data.last))));
    // Stage 1 has redone these days, and now stage 2 has too.
    await tx.delete(intradayDirty).where(eq(intradayDirty.userId, userId));
  });
}

/** daily_scores column name to its schema key. */
const camel = (k: string) => k.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());

/** Stage 1's cached rows, hypnograms, the journal and the stored journal impact. */
async function readInputs(db: Db, userId: number) {
  const ds = dailyScores;
  const sg = sleepSegments;
  const sa = sleepAwakenings;
  const je = journalEntries;
  const [scored, segments, awakenings, entries] = await Promise.all([
    db
      .select({ day: ds.day, strain: ds.strain, activities: ds.activities, sessionRhr: ds.sessionRhrBpm, recovery: ds.recovery, impact: ds.journalImpact })
      .from(ds)
      .where(eq(ds.userId, userId)),
    db
      .select({ sessionId: sg.sessionId, startTs: sg.startTs, endTs: sg.endTs, stage: sg.stage })
      .from(sg)
      .where(eq(sg.userId, userId))
      .orderBy(sg.startTs),
    db
      .select({ sessionId: sa.sessionId, n: sql<number>`count(*)::int` })
      .from(sa)
      .where(eq(sa.userId, userId))
      .groupBy(sa.sessionId),
    // Tags in byte order, as SQLite sorted them: their order is part of journal impact's memo key.
    db.select({ day: je.day, tag: je.tag, value: je.value }).from(je).where(eq(je.userId, userId)).orderBy(je.day, sql`${je.tag} collate "C"`),
  ]);
  const cached = new Map(
    scored.map((r): [string, Cached] => [
      r.day,
      {
        s1: r.strain as Stage1Day,
        activities: (r.activities ?? []) as Stage1Activity[],
        sessionRhr: r.sessionRhr,
        recovery: (r.recovery ?? null) as RecoveryRow | null,
      },
    ]),
  );
  const storedImpact = new Map(scored.map((r) => [r.day, (r.impact ?? null) as JournalImpactRow | null]));
  const journal = groupBy(entries, (e) => e.day);
  const inputs: Inputs = {
    cached,
    // Filled a batch of days at a time by stage2.
    stillHr: new Map(),
    loadSeries: new Map(),
    segments: groupBy(segments as Segment[], (s) => s.sessionId),
    awakenings: new Map(awakenings.map((a) => [a.sessionId, Number(a.n)])),
    tagOn: (day, tag) => (journal.get(day) ?? []).some((e) => e.tag === tag && e.value > 0),
  };
  return { inputs, journal, storedImpact };
}
