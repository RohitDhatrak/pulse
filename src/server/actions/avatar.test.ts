import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db";
import { exercises, hrvDays, journalEntries, oauthTokens, sleepAwakenings, sleepSessions, spo2Days } from "../db/schema";
import { writeSamples } from "../samples";
import { avatarSrc, connectedGoogleEmail, forgetSyncedData, ownerName, setAvatar, setGoogleAccount, uploadedAvatar } from "../avatar";
import { addUser, freshDb, USER } from "../testing";
import { removeAvatar, uploadAvatar } from "./avatar";

const ME = { userId: USER, email: "me@example.com", name: "Me", username: "me", image: null };
const h = vi.hoisted(() => ({ db: undefined as unknown, user: null as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../auth", async (orig) => ({ ...(await orig<object>()), currentUser: async () => h.user }));
vi.mock("../db", async (orig) => ({ ...(await orig<object>()), getDb: () => h.db as Db }));
vi.mock("../config", async (orig) => ({ ...(await orig<object>()), getConfig: () => ({ avatarUrl: null }) }));

let db: Db;
let other: number;
const form = (file: File) => {
  const f = new FormData();
  f.set("photo", file);
  return f;
};
const grant = (userId: number) => ({ userId, accessToken: "a", refreshToken: "r", expiresAt: 1, scope: "s", updatedAt: 1 });
const PHOTO = "https://lh3.googleusercontent.com/a/me";

beforeEach(async () => {
  db = h.db = await freshDb();
  other = await addUser(db);
  await db.insert(oauthTokens).values([grant(USER), grant(other)]);
  await setGoogleAccount(db, USER, { email: "fit@gmail.com", name: "Fit Person", picture: PHOTO });
  h.user = ME;
});

describe("avatar", () => {
  it("an upload wins over the Google photo, and removing it falls back to Google", async () => {
    expect(await avatarSrc(db, USER)).toBe(PHOTO);
    expect(await uploadAvatar(form(new File([new Uint8Array([1, 2, 3])], "me.png", { type: "image/png" })))).toEqual({ ok: true, data: undefined });
    expect(await avatarSrc(db, USER)).toMatch(/^\/avatar\?v=\d+$/);
    expect(await uploadedAvatar(db, USER)).toMatchObject({ type: "image/png", bytes: Buffer.from([1, 2, 3]) });
    // Each user sees only their own.
    expect(await uploadedAvatar(db, other)).toBeNull();
    expect(await avatarSrc(db, other)).toBeNull();
    await removeAvatar();
    expect(await avatarSrc(db, USER)).toBe(PHOTO);
  });

  it("refuses other types, oversize files and signed-out callers", async () => {
    expect(await uploadAvatar(form(new File(["<svg/>"], "x.svg", { type: "image/svg+xml" })))).toMatchObject({ ok: false });
    expect(await uploadAvatar(new FormData())).toMatchObject({ ok: false, error: "Choose a photo" });
    expect(await uploadAvatar(form(new File([new Uint8Array(1024 * 1024)], "max.webp", { type: "image/webp" })))).toMatchObject({ ok: true });
    await setAvatar(db, USER, null);
    expect(await uploadAvatar(form(new File([new Uint8Array(1024 * 1024 + 1)], "big.jpg", { type: "image/jpeg" })))).toMatchObject({
      ok: false,
      error: "Use a photo under 1 MB",
    });
    h.user = null;
    expect(await uploadAvatar(form(new File([new Uint8Array([1])], "a.png", { type: "image/png" })))).toMatchObject({ ok: false });
    expect(await uploadedAvatar(db, USER)).toBeNull();
  });
});

describe("Google account", () => {
  it("name and email come from the user's own grant", async () => {
    expect([await ownerName(db, USER), await connectedGoogleEmail(db, USER)]).toEqual(["Fit Person", "fit@gmail.com"]);
    expect([await ownerName(db, other), await connectedGoogleEmail(db, other)]).toEqual([null, null]);
  });

  it("forgetSyncedData clears only that user's synced rows and Google name and photo; the journal stays", async () => {
    const ex = (userId: number) => ({ userId, id: "x", day: "2026-09-01", startTs: 1, endTs: 2, type: "WALKING", source: "google" });
    await db.insert(exercises).values([ex(USER), ex(other)]);
    await db.insert(journalEntries).values({ userId: USER, day: "2026-09-01", tag: "alcohol", value: 1 });
    await setGoogleAccount(db, other, { email: "o@gmail.com", name: "Other", picture: PHOTO });
    // Version 35's tables: overnight samples and a night's brief awakenings.
    for (const u of [USER, other]) {
      await writeSamples(db, "hrv", u, [{ ts: 1_790_000_000, v: 313 }]);
      await writeSamples(db, "spo2", u, [{ ts: 1_790_000_000, v: 964 }]);
      await db.insert(sleepSessions).values({ userId: u, id: "n", day: "2026-09-01", startTs: 1, endTs: 9, isMain: true, processed: true, source: "FITBIT" });
      await db.insert(sleepAwakenings).values({ userId: u, sessionId: "n", startTs: 2, endTs: 3, stage: "light" });
    }
    await forgetSyncedData(db, USER);
    expect(await db.select({ userId: exercises.userId }).from(exercises)).toEqual([{ userId: other }]);
    for (const t of [hrvDays, spo2Days, sleepAwakenings]) expect(await db.select({ userId: t.userId }).from(t)).toEqual([{ userId: other }]);
    expect(await db.select().from(journalEntries)).toHaveLength(1);
    expect(await ownerName(db, USER)).toBeNull();
    expect(await avatarSrc(db, USER)).toBeNull();
    expect(await connectedGoogleEmail(db, USER)).toBe("fit@gmail.com");
    expect(await ownerName(db, other)).toBe("Other");
  });
});
