// Band heart rate, per-minute steps, and overnight HRV and SpO2 (tenths), stored as one row per user and UTC day
// (hr_days, steps_days, hrv_days, spo2_days): parallel arrays of second-of-day offsets and values, sorted by offset.
// UTC buckets never move when the time zone changes.
import { and, between, eq } from "drizzle-orm";
import { type Db, row, sql } from "./db";
import { hrDays, hrvDays, spo2Days, stepsDays } from "./db/schema";

export type SampleTable = "hr" | "steps" | "hrv" | "spo2";
const T = { hr: hrDays, steps: stepsDays, hrv: hrvDays, spo2: spo2Days } as const;
const DAY = 86_400;
export const bucketOf = (ts: number) => Math.floor(ts / DAY);

type Row = { bucket: number; offsets: number[]; values: number[] };

async function load(db: Db, table: SampleTable, userId: number, lo: number, hi: number): Promise<Row[]> {
  const t = T[table];
  if (hi <= lo) return [];
  return db
    .select({ bucket: t.bucket, offsets: t.offsets, values: t.values })
    .from(t)
    .where(and(eq(t.userId, userId), between(t.bucket, bucketOf(lo), bucketOf(hi - 1))))
    .orderBy(t.bucket);
}

/** Samples with lo <= ts < hi, in time order. */
export async function readSamples(db: Db, table: SampleTable, userId: number, lo: number, hi: number): Promise<{ ts: number; v: number }[]> {
  const out: { ts: number; v: number }[] = [];
  for (const r of await load(db, table, userId, lo, hi)) {
    const base = r.bucket * DAY;
    for (let i = 0; i < r.offsets.length; i++) {
      const ts = base + r.offsets[i];
      if (ts >= lo && ts < hi) out.push({ ts, v: r.values[i] });
    }
  }
  return out;
}

/** Heart rate as the scorers want it. */
export const readHr = async (db: Db, userId: number, lo: number, hi: number) =>
  (await readSamples(db, "hr", userId, lo, hi)).map((s) => ({ ts: s.ts, bpm: s.v }));

/** Overnight HRV (ms) or SpO2 (%) samples, stored in tenths (version 35). */
export const readTenths = async (db: Db, table: "hrv" | "spo2", userId: number, lo: number, hi: number) =>
  (await readSamples(db, table, userId, lo, hi)).map((s) => ({ ts: s.ts, v: s.v / 10 }));

/** The first and last sample time, or null with none. Reads only the first and last bucket's end offsets. */
export async function sampleRange(db: Db, table: SampleTable, userId: number): Promise<{ min: number; max: number } | null> {
  const t = T[table];
  const r = await row<{ min: number | null; max: number | null }>(
    db,
    sql`select
      (select bucket * 86400 + offsets[1] from ${t} where ${t.userId} = ${userId} order by bucket limit 1) as min,
      (select bucket * 86400 + offsets[array_length(offsets, 1)] from ${t} where ${t.userId} = ${userId} order by bucket desc limit 1) as max`,
  );
  return r?.min == null || r.max == null ? null : { min: Number(r.min), max: Number(r.max) };
}

/**
 * Merges a sync window's samples into storage and returns the timestamps whose value changed (added, updated or
 * removed), for dirty-day marking.
 * - "replace" (heart rate): inside [lo, hi) the stored samples become exactly `incoming`; outside, they stay.
 * - "max" (steps): each minute keeps the larger of stored and incoming; nothing is removed.
 */
export async function mergeSamples(
  db: Db,
  table: SampleTable,
  userId: number,
  win: { start: number; end: number },
  incoming: Map<number, number>,
  mode: "replace" | "max",
): Promise<number[]> {
  const t = T[table];
  // A loop, not Math.min(...keys): a day can hold 86k keys, past what a spread call takes as arguments.
  let lo = win.start;
  let hi = win.end;
  for (const k of incoming.keys()) {
    if (k < lo) lo = k;
    if (k + 1 > hi) hi = k + 1;
  }
  const stored = new Map((await load(db, table, userId, lo, hi)).map((r) => [r.bucket, r]));
  const buckets = new Set<number>(stored.keys());
  for (const ts of incoming.keys()) buckets.add(bucketOf(ts));
  if (mode === "replace") for (let b = bucketOf(win.start); b <= bucketOf(win.end - 1); b++) buckets.add(b);

  const changed: number[] = [];
  for (const b of buckets) {
    const base = b * DAY;
    const before = new Map<number, number>();
    const r = stored.get(b);
    if (r) for (let i = 0; i < r.offsets.length; i++) before.set(base + r.offsets[i], r.values[i]);
    const after = new Map(before);
    if (mode === "replace") {
      for (const ts of before.keys()) if (ts >= win.start && ts < win.end && !incoming.has(ts)) after.delete(ts);
    }
    for (const [ts, v] of incoming) {
      if (bucketOf(ts) !== b) continue;
      if (mode === "max") after.set(ts, Math.max(v, before.get(ts) ?? v));
      else after.set(ts, v);
    }
    const n = changed.length;
    for (const ts of new Set([...before.keys(), ...after.keys()])) if (before.get(ts) !== after.get(ts)) changed.push(ts);
    if (changed.length === n) continue;
    const sorted = [...after].sort((a, z) => a[0] - z[0]);
    if (!sorted.length) {
      await db.delete(t).where(and(eq(t.userId, userId), eq(t.bucket, b)));
      continue;
    }
    const values = { offsets: sorted.map(([ts]) => ts - base), values: sorted.map(([, v]) => v) };
    await db
      .insert(t)
      .values({ userId, bucket: b, ...values })
      .onConflictDoUpdate({ target: [t.userId, t.bucket], set: values });
  }
  return changed;
}

/** Writes generated samples (the seed) without reading first: whole buckets, replacing what was there. */
export async function writeSamples(db: Db, table: SampleTable, userId: number, samples: { ts: number; v: number }[]) {
  const t = T[table];
  const byBucket = new Map<number, { ts: number; v: number }[]>();
  for (const s of samples) {
    const b = bucketOf(s.ts);
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b)!.push(s);
  }
  for (const [b, xs] of byBucket) {
    xs.sort((a, z) => a.ts - z.ts);
    const base = b * DAY;
    const existing = await load(db, table, userId, base, base + DAY);
    const merged = new Map<number, number>();
    for (const r of existing) for (let i = 0; i < r.offsets.length; i++) merged.set(base + r.offsets[i], r.values[i]);
    for (const s of xs) if (!merged.has(s.ts)) merged.set(s.ts, s.v); // keep stored, like insert-or-ignore
    const sorted = [...merged].sort((a, z) => a[0] - z[0]);
    const values = { offsets: sorted.map(([ts]) => ts - base), values: sorted.map(([, v]) => v) };
    await db.insert(t).values({ userId, bucket: b, ...values }).onConflictDoUpdate({ target: [t.userId, t.bucket], set: values });
  }
}
