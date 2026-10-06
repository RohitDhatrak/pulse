// Web Push: browsers the user turned notifications on in, and the two daily alerts the worker sends. Off (no-ops)
// unless the VAPID keys are set. Payload for the service worker: JSON { title, body, url, tag }.
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import webpush from "web-push";
import { BAND_WORD, recoveryBand } from "@/lib/bands";
import { getConfig } from "./config";
import { type Db } from "./db";
import { dailyScores, pushSubscriptions } from "./db/schema";
import { userTimeZone } from "./profile";
import { localDay } from "./time";

export type PushPayload = { title: string; body: string; url: string; tag: string };
type Sub = { endpoint: string; p256dh: string; auth: string };

/** The key the browser subscribes with; null when notifications are off on this server. */
export const pushPublicKey = () => getConfig().vapid?.publicKey ?? null;

/** One endpoint belongs to one browser profile: signing in as someone else there moves it to them. */
export async function saveSubscription(db: Db, userId: number, s: { endpoint: string; keys: { p256dh: string; auth: string } }, now = Math.floor(Date.now() / 1000)) {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, s.endpoint));
  await db.insert(pushSubscriptions).values({ userId, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, createdAt: now });
}

export async function removeSubscription(db: Db, userId: number, endpoint: string) {
  await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}

/** Sends to the given subscriptions (default: all the user's). Drops the ones the push service says are gone. Never throws. */
export async function sendPush(db: Db, userId: number, payload: PushPayload, subs?: Sub[]) {
  const vapid = getConfig().vapid;
  if (!vapid) return;
  try {
    subs ??= await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
    const body = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
            vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
            TTL: 6 * 3600,
            timeout: 10_000, // a push service that never answers must not hold the worker cycle for every user
          });
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) await removeSubscription(db, userId, s.endpoint);
          else console.error(`[push] user ${userId} send failed: ${status ?? (err instanceof Error ? err.message : String(err))}`);
        }
      }),
    );
  } catch (err) {
    console.error(`[push] user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Marks `column` as sent for `day` on every subscription not yet marked, and returns those: the atomic claim that
 * keeps two runs (or two replicas) from sending the same alert twice.
 * ponytail: claimed before sending, so a failed send isn't retried that day; add a retry if alerts must not be lost.
 */
async function claim(db: Db, userId: number, column: "lastRecoveryDay" | "lastSyncAlertDay", day: string): Promise<Sub[]> {
  const col = pushSubscriptions[column];
  return db
    .update(pushSubscriptions)
    .set({ [column]: day })
    .where(and(eq(pushSubscriptions.userId, userId), or(isNull(col), lt(col, day))))
    .returning({ endpoint: pushSubscriptions.endpoint, p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth });
}

/** After a run: "Recovery ready" once per local day, when today's recovery score exists. */
export async function notifyRecovery(db: Db, userId: number, now = Math.floor(Date.now() / 1000)) {
  if (!getConfig().vapid) return;
  try {
    const tz = await userTimeZone(db, userId);
    if (!tz) return;
    const day = localDay(now, tz);
    const [r] = await db
      .select({ value: sql<number | null>`(${dailyScores.recovery}->>'value')::float` })
      .from(dailyScores)
      .where(and(eq(dailyScores.userId, userId), eq(dailyScores.day, day)));
    if (r?.value == null) return;
    const subs = await claim(db, userId, "lastRecoveryDay", day);
    if (!subs.length) return;
    const value = Math.round(r.value);
    await sendPush(db, userId, { title: "Recovery ready", body: `${value}%: ${BAND_WORD[recoveryBand(value)]}`, url: "/recovery", tag: "recovery" }, subs);
  } catch (err) {
    console.error(`[push] user ${userId} recovery alert: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** When Google access is lost: "Pulse can't sync", once per local day. */
export async function notifySyncProblem(db: Db, userId: number, now = Math.floor(Date.now() / 1000)) {
  if (!getConfig().vapid) return;
  try {
    const tz = (await userTimeZone(db, userId)) ?? "UTC";
    const subs = await claim(db, userId, "lastSyncAlertDay", localDay(now, tz));
    if (!subs.length) return;
    await sendPush(db, userId, { title: "Pulse can’t sync", body: "Google access was lost. Open Settings to reconnect.", url: "/settings", tag: "sync" }, subs);
  } catch (err) {
    console.error(`[push] user ${userId} sync alert: ${err instanceof Error ? err.message : String(err)}`);
  }
}
