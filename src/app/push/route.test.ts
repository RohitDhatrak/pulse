// POST /push: the server later POSTs to the stored endpoint, so only https browser push services are accepted.
import { NextRequest } from "next/server";
import { beforeAll, expect, it, vi } from "vitest";
import type { Db } from "@/server/db";
import { pushSubscriptions } from "@/server/db/schema";
import { freshDb, USER } from "@/server/testing";
import { POST } from "./route";

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/server/db", async (orig) => ({ ...(await orig<object>()), getDb: () => h.db as Db }));
vi.mock("@/server/auth", async (orig) => ({ ...(await orig<object>()), requestUser: async () => ({ userId: USER }) }));

let db: Db;
beforeAll(async () => {
  db = h.db = await freshDb();
});

const subscribe = (endpoint: string) =>
  POST(new NextRequest("http://pulse:3000/push", { method: "POST", body: JSON.stringify({ endpoint, keys: { p256dh: "k", auth: "a" } }) }));

it("stores a browser push service endpoint and refuses internal or plain-http ones", async () => {
  for (const ok of ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/Q"]) {
    expect((await subscribe(ok)).status).toBe(200);
  }
  for (const bad of ["http://127.0.0.1:8443/internal", "https://10.0.0.5/x", "http://fcm.googleapis.com/fcm/send/abc", "https://fcm.googleapis.com.evil.example/x", "https://evilfcm.googleapis.com.example/x"]) {
    expect((await subscribe(bad)).status).toBe(400);
  }
  expect((await db.select().from(pushSubscriptions)).length).toBe(3);
});
