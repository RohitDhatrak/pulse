import type { NextRequest } from "next/server";
import { z } from "zod";
import { requestUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { removeSubscription, saveSubscription } from "@/server/push";

const NO_STORE = { "cache-control": "no-store" };
// The server POSTs to the endpoint later, so only https on a browser push service: anything else would let a user aim
// the server at an internal host (Chrome/Edge/Opera/Samsung use FCM, Firefox Mozilla, Safari Apple, legacy Edge WNS).
const PUSH_HOST = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
const Endpoint = z.url({ protocol: /^https$/ }).max(2048).refine((u) => PUSH_HOST.test(new URL(u).hostname), "Unsupported push service");
const Subscription = z.object({ endpoint: Endpoint, keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) }) });

/** Turn notifications on: stores the browser's PushSubscription for the signed-in user. Like /sync, no Origin check: a cross-site POST carries no session cookie. */
export async function POST(req: NextRequest) {
  const user = await requestUser(req);
  if (!user) return Response.json({ ok: false, error: "Signed out. Sign in again." }, { status: 401, headers: NO_STORE });
  const sub = Subscription.safeParse(await req.json().catch(() => null));
  if (!sub.success) return Response.json({ ok: false, error: "Bad subscription" }, { status: 400, headers: NO_STORE });
  await saveSubscription(getDb(), user.userId, sub.data);
  return Response.json({ ok: true }, { headers: NO_STORE });
}

/** Turn notifications off for this browser: body `{ endpoint }`. */
export async function DELETE(req: NextRequest) {
  const user = await requestUser(req);
  if (!user) return Response.json({ ok: false, error: "Signed out. Sign in again." }, { status: 401, headers: NO_STORE });
  const body = z.object({ endpoint: z.string().max(2048) }).safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ ok: false, error: "Bad request" }, { status: 400, headers: NO_STORE });
  await removeSubscription(getDb(), user.userId, body.data.endpoint);
  return Response.json({ ok: true }, { headers: NO_STORE });
}
