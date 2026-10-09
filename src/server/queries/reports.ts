import type { Report } from "@/core/algorithms/reports";
import { and, asc, desc, eq, gt, like, lt } from "drizzle-orm";
import { journalTags, reports } from "../db/schema";
import { finite, loadDays, none, ok, type QueryCtx, toStrain } from "./common";
import { latestReport } from "./home";
import type { DriverItem, KeyStat, Metric, ReportVM, StackedSegment } from "./types";

const readReport = async (ctx: QueryCtx, period: string) => {
  const [r] = await ctx.db
    .select({ data: reports.data })
    .from(reports)
    .where(and(eq(reports.userId, ctx.userId), eq(reports.period, period)));
  return r ? (r.data as Report) : null;
};

/** The nearest same-kind period before (`dir` -1) or after (+1) `period`, or null. */
const neighbour = async (ctx: QueryCtx, pattern: string, period: string, dir: -1 | 1) => {
  const [r] = await ctx.db
    .select({ period: reports.period })
    .from(reports)
    .where(and(eq(reports.userId, ctx.userId), like(reports.period, pattern), dir < 0 ? lt(reports.period, period) : gt(reports.period, period)))
    .orderBy(dir < 0 ? desc(reports.period) : asc(reports.period))
    .limit(1);
  return r?.period ?? null;
};

const BALANCE = {
  LOAD_SWEET_SPOT: { status: "balanced", word: "Balanced", line: "Your strain matched your recovery most days." },
  LOAD_BUILDING_FAST: { status: "overreaching", word: "Overreaching", line: "Your load rose faster than your body is used to. Watch your Recovery." },
  LOAD_SPIKING: { status: "overreaching", word: "Overreaching", line: "Your load jumped well above your usual. Injury and illness risk rise." },
  LOAD_RAMPING_DOWN: { status: "undertrained", word: "Undertrained", line: "Your load dropped below your usual. Fitness slowly fades if this lasts." },
} as const;

/** Reports `/reports/[period]` (spec §7.13); null for a period with no data. */
export async function getReport(period: string, ctx: QueryCtx): Promise<ReportVM | null> {
  const r = await readReport(ctx, period);
  if (!r || r.days === 0) return null;
  const kind = r.kind;
  const pattern = kind === "week" ? "____-W__" : "____-__";
  const [prev, next, rows] = await Promise.all([neighbour(ctx, pattern, period, -1), neighbour(ctx, pattern, period, 1), loadDays(ctx, r.start, r.end)]);
  const [prevReport, latestWeek, latestMonth, labels] = await Promise.all([
    prev ? readReport(ctx, prev) : null,
    latestReport(ctx, "week"),
    latestReport(ctx, "month"),
    tagLabels(ctx),
  ]);

  const avg = (v: number | null): Metric<number> => (finite(v) ? ok(v) : none("no_data"));
  const word = kind === "week" ? "week" : "month";
  const stat = (key: string, label: string, v: number | null, prevV: number | null | undefined, unit: string | undefined, direction: KeyStat["direction"]): KeyStat => ({
    key,
    label,
    metric: avg(v),
    ...(unit && { unit }),
    average: finite(prevV) ? prevV : null,
    direction,
  });
  const a = r.averages;
  const pa = prevReport?.averages;

  const bands: StackedSegment[] = [
    { key: "green", label: "Green (67-100%)", count: r.bands.green, color: "recovery-green" },
    { key: "yellow", label: "Yellow (34-66%)", count: r.bands.yellow, color: "recovery-yellow" },
    { key: "red", label: "Red (0-33%)", count: r.bands.red, color: "recovery-red" },
  ];
  const scored = r.bands.green + r.bands.yellow + r.bands.red;

  let inTarget = 0;
  let withTarget = 0;
  for (const row of rows.values()) {
    const t = row.strainTarget;
    if (t?.reason === null && row.s1?.effort != null) {
      withTarget++;
      const s = toStrain(row.s1.effort);
      if (s >= t.low && s <= t.high) inTarget++;
    }
  }
  const tb = r.trainingBalance ? BALANCE[r.trainingBalance.status as keyof typeof BALANCE] : null;
  const strainOf = (day: string) => {
    const e = rows.get(day)?.s1?.effort;
    return e == null ? null : toStrain(e);
  };

  const impacts: DriverItem[] = r.topImpacts.map((t) => ({
    key: t.tag,
    label: labels.get(t.tag) ?? t.tag,
    delta: t.effects.recovery.delta!,
    effect: t.effects.recovery.label === "positive" ? "positive" : "negative",
    yes: t.effects.recovery.nYes,
    no: t.effects.recovery.nNo,
    ci: [t.effects.recovery.ciLow!, t.effects.recovery.ciHigh!],
  }));

  return {
    period,
    kind,
    start: r.start,
    end: r.end,
    partial: r.partial,
    prev,
    next,
    latestWeek: latestWeek?.period ?? null,
    latestMonth: latestMonth?.period ?? null,
    dials: [
      { key: "sleep", label: "Avg sleep", metric: avg(a.sleepPerf), delta: r.deltas.sleepPerf },
      { key: "recovery", label: "Avg recovery", metric: avg(a.recovery), delta: r.deltas.recovery },
      { key: "strain", label: "Avg strain", metric: avg(a.strain), delta: r.deltas.strain },
    ],
    insight: insightOf(r, word, inTarget, withTarget),
    bands: scored ? ok(bands) : none("no_data"),
    averages: [
      stat("recovery", "Recovery", a.recovery, pa?.recovery, "%", "up"),
      stat("strain", "Day strain", a.strain, pa?.strain, undefined, "neutral"),
      stat("sleepPerf", "Sleep performance", a.sleepPerf, pa?.sleepPerf, "%", "up"),
      stat("sleepHours", "Hours of sleep", a.sleepHours, pa?.sleepHours, "h", "up"),
      stat("consistency", "Sleep consistency", r.sleepConsistency, prevReport?.sleepConsistency, "%", "up"),
      stat("hrv", "Heart rate variability", a.hrv, pa?.hrv, "ms", "up"),
      stat("rhr", "Resting heart rate", a.rhr, pa?.rhr, "bpm", "down"),
    ],
    trainingBalance: r.trainingBalance && tb ? ok({ status: tb.status, word: tb.word, acwr: r.trainingBalance.acwr, line: tb.line }) : none(r.lightLoad ? "light_load" : "no_data"),
    topImpacts: impacts,
    bestWorst:
      r.best && r.worst && scored >= 2
        ? [
            { label: "Best day", day: r.best.day, recovery: r.best.recovery, strain: strainOf(r.best.day) },
            { label: "Worst day", day: r.worst.day, recovery: r.worst.recovery, strain: strainOf(r.worst.day) },
          ]
        : null,
  };
}

async function tagLabels(ctx: QueryCtx) {
  const rows = await ctx.db.select({ tag: journalTags.tag, label: journalTags.label }).from(journalTags).where(eq(journalTags.userId, ctx.userId));
  return new Map(rows.map((r) => [r.tag, r.label]));
}

function insightOf(r: Report, word: string, inTarget: number, withTarget: number): string | null {
  if (r.averages.recovery == null) return null;
  const scored = r.bands.green + r.bands.yellow + r.bands.red;
  const mood = r.bands.red > r.bands.green ? "A demanding" : r.bands.green * 2 >= scored ? "A strong" : "A balanced";
  const parts = [`${mood} ${word}: ${r.bands.green} green ${r.bands.green === 1 ? "day" : "days"}`];
  if (withTarget) parts[0] += ` and strain inside your target on ${inTarget} of ${withTarget} days`;
  parts[0] += ".";
  if (r.deltas.sleepPerf != null && Math.abs(r.deltas.sleepPerf) >= 3) {
    parts.push(`Sleep performance ${r.deltas.sleepPerf > 0 ? "rose" : "dipped"} ${Math.abs(Math.round(r.deltas.sleepPerf))} points from last ${word}.`);
  }
  return parts.join(" ");
}

/** One period in the archive: its dates and the three headline averages (null where none). */
export type ReportListItem = {
  period: string;
  start: string;
  end: string;
  partial: boolean;
  recovery: number | null;
  strain: number | null;
  sleepPerf: number | null;
};
export type ReportArchiveVM = { weeks: ReportListItem[]; months: ReportListItem[] };

/** Reports archive `/reports` (More): every week and month that has data, newest first. */
export async function getReportArchive(ctx: QueryCtx): Promise<ReportArchiveVM> {
  const rows = await ctx.db
    .select({ period: reports.period, data: reports.data })
    .from(reports)
    .where(eq(reports.userId, ctx.userId))
    .orderBy(desc(reports.period));
  const out: ReportArchiveVM = { weeks: [], months: [] };
  for (const row of rows) {
    const r = row.data as Report;
    if (!r.days) continue;
    const a = r.averages;
    (r.kind === "week" ? out.weeks : out.months).push({
      period: row.period,
      start: r.start,
      end: r.end,
      partial: r.partial,
      recovery: finite(a.recovery) ? a.recovery : null,
      strain: finite(a.strain) ? a.strain : null,
      sleepPerf: finite(a.sleepPerf) ? a.sleepPerf : null,
    });
  }
  return out;
}
