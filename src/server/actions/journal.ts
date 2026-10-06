"use server";
// Journal writes (KTD1): Server Actions validated with zod. Results are returned, not thrown, so a form can show them.
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { currentUser, SIGNED_OUT } from "../auth";
import { getDb } from "../db";
import { intradayDirty, journalEntries, journalTags } from "../db/schema";
import { addTag, MAX_TAGS, reorderTags, setTagHidden, tagKey } from "../journalTags";
import { userCtx } from "../queries/common";
import { getJournal } from "../queries/journal";
import { userTimeZone } from "../profile";
import { localDay } from "../time";
import type { JournalVM } from "../queries/types";
import { requestSync } from "../worker";
import { inDayRange } from "@/lib/url";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

/** Today's local `YYYY-MM-DD` in the user's time zone (UTC before onboarding). */
const localToday = async (userId: number) => localDay(Math.floor(Date.now() / 1000), (await userTimeZone(getDb(), userId)) ?? "UTC");

const Entry = z.object({
  day: z.iso.date(),
  tag: z.string().min(1).max(64),
  // A yes/no behaviour, or a count (e.g. drinks); stored as an integer. null clears the answer: no row
  // means "not answered", which journal impact keeps apart from an answered "no" (0).
  value: z.union([z.boolean(), z.number().int().min(0).max(1000)]).transform(Number).nullable(),
});

/** Upserts (or, with value null, deletes) one (day, tag) for today or a past day. Repeating it changes nothing. */
export async function saveJournalEntry(input: z.input<typeof Entry>): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return SIGNED_OUT;
  const { userId } = user;
  const r = Entry.safeParse(input);
  if (!r.success) return { ok: false, error: r.error.issues[0].message };
  const { day, tag, value } = r.data;
  if (day > (await localToday(userId))) return { ok: false, error: "Can’t log a future day" };
  const db = getDb();
  const [known] = await db.select({ tag: journalTags.tag }).from(journalTags).where(and(eq(journalTags.userId, userId), eq(journalTags.tag, tag)));
  if (!known) return { ok: false, error: `Unknown tag: ${tag}` };
  if (value === null) {
    await db.delete(journalEntries).where(and(eq(journalEntries.userId, userId), eq(journalEntries.day, day), eq(journalEntries.tag, tag)));
  } else {
    await db
      .insert(journalEntries)
      .values({ userId, day, tag, value })
      .onConflictDoUpdate({ target: [journalEntries.userId, journalEntries.day, journalEntries.tag], set: { value } });
  }
  // Stage 2 reads the journal (impact, Insights, Monitor context) but a check-in is no source change, so
  // mark the day dirty (persistent, survives a restart; stage 1 redoes only that day, to the same result)
  // and kick the worker past its 5-minute gate. Fire-and-forget: the action doesn't wait on the recompute.
  await db.insert(intradayDirty).values({ userId, day }).onConflictDoNothing();
  requestSync({ userId, force: true });
  revalidatePath("/journal");
  revalidatePath("/");
  return { ok: true, data: undefined };
}

/**
 * Read-only: the check-in sheet's behaviours and a day's answers. The sheet opens over any screen (`?checkin=1`,
 * spec §11 UX2), so it fetches what the Journal page would have passed it.
 */
export async function loadCheckIn(day: string): Promise<ActionResult<Pick<JournalVM, "tags" | "checkIn">>> {
  const user = await currentUser();
  if (!user) return SIGNED_OUT;
  const r = z.iso.date().safeParse(day);
  if (!r.success) return { ok: false, error: "Invalid day" };
  const ctx = await userCtx(user.userId);
  if (!inDayRange(r.data, localDay(ctx.now, ctx.timeZone))) return { ok: false, error: "Invalid day" };
  // ponytail: getJournal also builds the strip, history and teaser the sheet drops; a lean query if it ever shows.
  const { tags, checkIn } = await getJournal(r.data, ctx);
  return { ok: true, data: { tags, checkIn } };
}

const CustomTag = z.object({ label: z.string().trim().min(1).max(40) });

/** Adds a custom tag; its key is the label as snake_case. Fails when that key already exists. */
export async function addCustomTag(input: z.input<typeof CustomTag>): Promise<ActionResult<{ tag: string }>> {
  const user = await currentUser();
  if (!user) return SIGNED_OUT;
  const r = CustomTag.safeParse(input);
  if (!r.success) return { ok: false, error: r.error.issues[0].message };
  const { label } = r.data;
  const tag = tagKey(label);
  if (!tag) return { ok: false, error: "Label needs a letter or digit" };
  const added = await addTag(getDb(), user.userId, tag, label);
  if (added === "exists") return { ok: false, error: `Tag already exists: ${tag}` };
  if (added === "full") return { ok: false, error: `Too many behaviours: the limit is ${MAX_TAGS}` };
  revalidateTags();
  return { ok: true, data: { tag } };
}

const revalidateTags = () => {
  revalidatePath("/journal");
  revalidatePath("/more/behaviours");
};

const Hidden = z.object({ tag: z.string().min(1).max(64), hidden: z.boolean() });

/** Hides a behaviour from the check-in sheet, or shows it again. Its past answers stay and still count in insights. */
export async function setBehaviourHidden(input: z.input<typeof Hidden>): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return SIGNED_OUT;
  const r = Hidden.safeParse(input);
  if (!r.success) return { ok: false, error: r.error.issues[0].message };
  if (!(await setTagHidden(getDb(), user.userId, r.data.tag, r.data.hidden))) return { ok: false, error: `Unknown tag: ${r.data.tag}` };
  revalidateTags();
  return { ok: true, data: undefined };
}

const Order = z.object({ tags: z.array(z.string().min(1).max(64)).min(1).max(200) });

/** Sets the order of one check-in group's behaviours. */
export async function reorderBehaviours(input: z.input<typeof Order>): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return SIGNED_OUT;
  const r = Order.safeParse(input);
  if (!r.success) return { ok: false, error: r.error.issues[0].message };
  if (!(await reorderTags(getDb(), user.userId, r.data.tags))) return { ok: false, error: "Unknown or repeated tag" };
  revalidateTags();
  return { ok: true, data: undefined };
}
