import { type ImpactMetric, strengthOf, type TagImpact } from "@/core/algorithms/journalImpact";
import type { JournalImpactRow } from "../pipeline";
import { addDays } from "../time";
import { and, count, desc, eq, gte, isNotNull, lte } from "drizzle-orm";
import { dailyScores, journalEntries, journalTags } from "../db/schema";
import { type QueryCtx, todayOf } from "./common";
import type { BehavioursVM, ImpactMetricKey, JournalInsightsVM, JournalTag, JournalVM } from "./types";

const GROUP: Record<string, JournalTag["group"]> = {
  alcohol: "evening",
  late_caffeine: "evening",
  late_meal: "evening",
  screen_in_bed: "evening",
  meditation: "recovery",
  stretching: "recovery",
  sauna: "recovery",
  travel: "context",
  illness: "context",
};

/** Every tag, hidden ones included, in check-in order (position inside a group, then insertion order). */
async function tagsOf(ctx: QueryCtx): Promise<JournalTag[]> {
  const t = journalTags;
  const rows = await ctx.db
    .select({ tag: t.tag, label: t.label, isDefault: t.isDefault, hidden: t.hidden })
    .from(t)
    .where(eq(t.userId, ctx.userId))
    .orderBy(t.position, t.seq);
  return rows.map((r) => ({ tag: r.tag, label: r.label, isDefault: r.isDefault, hidden: r.hidden, group: GROUP[r.tag] ?? "custom" }));
}

/** More › Behaviours: every tag, hidden ones included, with how many days answered it. */
export async function getBehaviours(ctx: QueryCtx): Promise<BehavioursVM> {
  const j = journalEntries;
  const [tags, n] = await Promise.all([
    tagsOf(ctx),
    ctx.db.select({ tag: j.tag, n: count() }).from(j).where(eq(j.userId, ctx.userId)).groupBy(j.tag),
  ]);
  const counts = new Map(n.map((r) => [r.tag, r.n]));
  return { tags: tags.map((t) => ({ ...t, answers: counts.get(t.tag) ?? 0 })) };
}

function entriesBetween(ctx: QueryCtx, from: string, to: string) {
  const j = journalEntries;
  return ctx.db
    .select({ day: j.day, tag: j.tag, value: j.value })
    .from(j)
    .where(and(eq(j.userId, ctx.userId), gte(j.day, from), lte(j.day, to)))
    .orderBy(j.day, j.tag);
}

/** The newest stored journal impact on or before today. */
async function latestImpact(ctx: QueryCtx): Promise<{ asOf: string; impacts: TagImpact[] } | null> {
  const s = dailyScores;
  const [r] = await ctx.db
    .select({ day: s.day, impact: s.journalImpact })
    .from(s)
    .where(and(eq(s.userId, ctx.userId), lte(s.day, todayOf(ctx)), isNotNull(s.journalImpact)))
    .orderBy(desc(s.day))
    .limit(1);
  return r ? { asOf: r.day, impacts: (r.impact as JournalImpactRow).impacts } : null;
}

/** Journal `/journal` for `day` (spec §7.11). */
export async function getJournal(day: string, ctx: QueryCtx): Promise<JournalVM> {
  const today = todayOf(ctx);
  const stripStart = day < addDays(today, -29) ? day : addDays(today, -29);
  const [tags, entries, impact] = await Promise.all([tagsOf(ctx), entriesBetween(ctx, stripStart, today), latestImpact(ctx)]);
  const label = new Map(tags.map((t) => [t.tag, t.label]));
  const byDay = new Map<string, typeof entries>();
  for (const e of entries) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);

  const strip: JournalVM["strip"] = [];
  for (let d = stripStart; d <= today; d = addDays(d, 1)) strip.push({ day: d, done: byDay.has(d) });
  const mine = byDay.get(day) ?? [];
  const yesOf = (es: typeof entries) => es.filter((e) => e.value > 0).map((e) => ({ tag: e.tag, label: label.get(e.tag) ?? e.tag }));

  const teaser = teaserOf(impact?.impacts ?? [], label);

  const history: JournalVM["history"] = [];
  for (let d = today; d >= addDays(today, -29); d = addDays(d, -1)) {
    const es = byDay.get(d);
    if (es) history.push({ day: d, yes: yesOf(es).map((y) => y.label) });
  }

  return {
    day,
    today,
    strip,
    // Hidden behaviours leave the check-in sheet; their answers stay, still label History and still count in insights.
    tags: tags.filter((t) => !t.hidden),
    checkIn: { done: mine.length > 0, entries: Object.fromEntries(mine.map((e) => [e.tag, e.value])), yes: yesOf(mine) },
    teaser,
    history,
  };
}

/**
 * The Journal's insight line. Only a clear effect (one that survives the false-discovery correction) is quoted, in
 * Recovery points; without one it says how many behaviours show a possible effect so far.
 */
export function teaserOf(impacts: TagImpact[], label: Map<string, string>): JournalVM["teaser"] {
  // `impacts` is ranked by |Δ recovery|, so the first clear one is the largest.
  const clearest = impacts.find((t) => strengthOf(t.effects.recovery.label) === "clear");
  if (clearest) {
    const d = clearest.effects.recovery.delta!;
    const name = (label.get(clearest.tag) ?? clearest.tag).toLowerCase();
    const points = Math.abs(Math.round(d));
    return { ready: true, text: `Your clearest effect so far: ${name} ${d < 0 ? "lowers" : "raises"} next-day Recovery by about ${points} ${points === 1 ? "point" : "points"}.` };
  }
  const possible = impacts.filter((t) => strengthOf(t.effects.recovery.label) === "possible").length;
  if (possible) {
    return { ready: true, text: `No clear effects yet. Keep logging: ${possible} ${possible === 1 ? "behaviour shows" : "behaviours show"} a possible effect.` };
  }
  if (impacts.some((t) => t.status === "ok")) return { ready: true, text: "No clear effects yet. Keep logging to see what your habits do." };
  return { ready: false, text: "Insights appear after 5 days with and 5 without a behaviour." };
}

const METRIC: Record<ImpactMetricKey, ImpactMetric> = { recovery: "recovery", hrv: "hrvZ", sleep: "sleepPerf" };

/** Journal Insights `/journal/insights?m=` (spec §7.12): effects on next-day Recovery, HRV (SD) or sleep. */
export async function getJournalInsights(metric: ImpactMetricKey = "recovery", ctx: QueryCtx): Promise<JournalInsightsVM> {
  const key = METRIC[metric];
  const unit = metric === "hrv" ? "SD" : "%";
  const impact = await latestImpact(ctx);
  if (!impact) return { metric, unit, items: [], needsMore: [] };
  const tags = await tagsOf(ctx);
  const label = new Map(tags.map((t) => [t.tag, t.label]));

  const items: JournalInsightsVM["items"] = [];
  const needsMore: JournalInsightsVM["needsMore"] = [];
  for (const t of impact.impacts) {
    const e = t.effects[key];
    const name = label.get(t.tag) ?? t.tag;
    if (e.label === "not_enough_data" || e.delta == null) {
      needsMore.push({ key: t.tag, label: name, yes: e.nYes, no: e.nNo });
      continue;
    }
    const strength = strengthOf(e.label);
    items.push({
      key: t.tag,
      label: name,
      delta: e.delta,
      effect: strength ? (e.delta > 0 ? "positive" : "negative") : "none",
      tentative: strength === "possible",
      yes: e.nYes,
      no: e.nNo,
      ci: [e.ciLow!, e.ciHigh!],
      // The stored averages, so they always match the stored Δ (a rescore since can't make them disagree).
      avgWith: e.meanYes ?? null,
      avgWithout: e.meanNo ?? null,
    });
  }
  items.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.key.localeCompare(b.key));
  return { metric, unit, items, needsMore };
}
