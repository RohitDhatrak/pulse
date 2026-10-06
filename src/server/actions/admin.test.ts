// The admin panel's actions: only admins of a Google instance, never on ADMIN_EMAILS owners, never on yourself.
import { beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { isAdmin, listAccounts, listInvites, signupMode } from "../admin";
import { parseConfig, type Config } from "../config";
import type { Db } from "../db";
import { account, oauthTokens, session, user } from "../db/schema";
import { addUser, freshDb, USER } from "../testing";
import { coachAccess, coachMode } from "../coach/store";
import { coachTexts, textHistory } from "../coach/texts";
import { createInviteAction, deleteAccountAction, resetPasswordAction, revokeInviteAction, saveCoachTextAction, setCoachAllowedAction, setCoachModeAction, setRoleAction, setSignupModeAction, signOutEverywhereAction } from "./admin";

const h = vi.hoisted(() => ({ db: undefined as unknown, cfg: undefined as unknown, user: null as unknown }));
vi.mock("../auth", async (orig) => ({ ...(await orig<object>()), currentUser: async () => h.user }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../db", async (orig) => ({ ...(await orig<object>()), getDb: () => h.db as Db }));
vi.mock("../config", async (orig) => ({ ...(await orig<object>()), getConfig: () => h.cfg as Config }));

const google = (extra: Record<string, string> = {}) => parseConfig({ DATA_SOURCE: "google", GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", ...extra });
const as = (userId: number) => (h.user = { userId, email: "x@pulse.test", name: "X", username: null, image: null });
const NOT_ADMIN = { ok: false, error: "Only an admin can do this." };
const DONE = { ok: true, data: undefined };

let db: Db;
let member: number;
let owner: number;
beforeEach(async () => {
  h.cfg = google({ ADMIN_EMAILS: "owner@pulse.test" });
  db = h.db = await freshDb();
  member = await addUser(db, "member@pulse.test");
  owner = await addUser(db, "owner@pulse.test");
  await db.update(user).set({ role: "admin" }).where(eq(user.id, USER));
  as(USER);
});

it("a member, a signed-out caller and a demo instance are refused, and nothing changes", async () => {
  as(member);
  expect(await setSignupModeAction("open")).toEqual(NOT_ADMIN);
  expect(await createInviteAction("Sam")).toEqual(NOT_ADMIN);
  expect(await setRoleAction(member, "admin")).toEqual(NOT_ADMIN);
  expect(await deleteAccountAction(USER)).toEqual(NOT_ADMIN);
  h.user = null;
  expect((await setSignupModeAction("open")).ok).toBe(false);
  h.cfg = parseConfig({});
  as(USER);
  expect(await setSignupModeAction("open")).toEqual(NOT_ADMIN);
  expect(await signupMode(db)).toBe("invite");
  expect(await listInvites(db)).toEqual([]);
});

it("ADMIN_EMAILS owners and role admins are admins; the account list labels them", async () => {
  expect(await isAdmin(db, owner)).toBe(true);
  expect(await isAdmin(db, USER)).toBe(true);
  expect(await isAdmin(db, member)).toBe(false);
  const roles = Object.fromEntries((await listAccounts(db)).map((a) => [a.id, a.role]));
  expect(roles).toEqual({ [USER]: "admin", [member]: "user", [owner]: "owner" });
});

it("sets the sign-up mode and refuses an unknown one", async () => {
  expect(await setSignupModeAction("open")).toEqual(DONE);
  expect(await signupMode(db)).toBe("open");
  expect((await setSignupModeAction("anyone" as never)).ok).toBe(false);
  expect(await signupMode(db)).toBe("open");
});

it("creates an invite (token returned once, label trimmed) and revokes it", async () => {
  const r = await createInviteAction("  Sam  ");
  expect(r.ok && r.data).toMatch(/^[\w-]{24}$/);
  const [inv] = await listInvites(db);
  expect(inv).toMatchObject({ label: "Sam", usedAt: null });
  expect(await revokeInviteAction(inv.id)).toEqual(DONE);
  expect(await listInvites(db)).toEqual([]);
});

it("promotes and demotes members, but never an owner", async () => {
  expect(await setRoleAction(member, "admin")).toEqual(DONE);
  expect(await isAdmin(db, member)).toBe(true);
  expect(await setRoleAction(member, "user")).toEqual(DONE);
  expect(await isAdmin(db, member)).toBe(false);
  expect(await setRoleAction(owner, "user")).toEqual({ ok: false, error: "Unknown account." });
  expect(await isAdmin(db, owner)).toBe(true);
});

it("deletes a member, but not yourself, an owner or an admin", async () => {
  expect(await deleteAccountAction(USER)).toEqual({ ok: false, error: "Delete your own account from Settings." });
  expect(await deleteAccountAction(owner)).toEqual({ ok: false, error: "Unknown account." });
  const other = await addUser(db, "other@pulse.test");
  await db.update(user).set({ role: "admin" }).where(eq(user.id, other));
  expect(await deleteAccountAction(other)).toEqual({ ok: false, error: "Remove admin from this account first." });
  expect(await deleteAccountAction(member)).toEqual(DONE);
  expect(await db.select().from(user).where(eq(user.id, member))).toEqual([]);
});

it("deleting an account revokes its Google grant at Google first, as Disconnect does", async () => {
  await db.insert(oauthTokens).values({ userId: member, accessToken: "at", refreshToken: "rt-member", expiresAt: 0, scope: "s", updatedAt: 0 });
  const f = vi.fn<typeof fetch>(async () => new Response("", { status: 200 }));
  vi.stubGlobal("fetch", f);
  try {
    expect(await deleteAccountAction(member)).toEqual(DONE);
  } finally {
    vi.unstubAllGlobals();
  }
  expect(String(f.mock.calls[0]?.[0])).toBe("https://oauth2.googleapis.com/revoke");
  expect(String((f.mock.calls[0][1] as RequestInit).body)).toBe("token=rt-member");
});

it("reset password: owners only, never themselves or another owner; the old sessions end", async () => {
  // USER is a promoted admin, not an owner.
  expect(await resetPasswordAction(member)).toEqual({ ok: false, error: "Only an owner (ADMIN_EMAILS) can reset passwords." });
  h.user = { userId: owner, email: "owner@pulse.test", name: "O", username: null, image: null };
  expect((await resetPasswordAction(owner)).ok).toBe(false);
  await db.insert(session).values({ token: "t-member", userId: member, expiresAt: new Date(Date.now() + 86_400_000), updatedAt: new Date() });
  const r = await resetPasswordAction(member);
  expect(r.ok && r.data).toMatch(/^[\w-]{16}$/);
  expect(await db.select().from(session).where(eq(session.userId, member))).toEqual([]);
  const [cred] = await db.select({ password: account.password }).from(account).where(eq(account.userId, member));
  expect(cred.password).toBeTruthy();
  expect(cred.password).not.toContain(r.ok ? r.data : "");
});

it("sign out everywhere: admins, on others only, and owners are left alone", async () => {
  await db.insert(session).values([
    { token: "a", userId: member, expiresAt: new Date(Date.now() + 86_400_000), updatedAt: new Date() },
    { token: "b", userId: member, expiresAt: new Date(Date.now() + 86_400_000), updatedAt: new Date() },
  ]);
  expect(await signOutEverywhereAction(USER)).toEqual({ ok: false, error: "Sign yourself out from Settings." });
  expect(await signOutEverywhereAction(owner)).toEqual({ ok: false, error: "Unknown account." });
  expect(await signOutEverywhereAction(member)).toEqual({ ok: true, data: 2 });
  as(member);
  expect(await signOutEverywhereAction(owner)).toEqual(NOT_ADMIN);
});

it("coach wording: only admins save it, only known keys, never empty or too long; each save is a version", async () => {
  as(member);
  expect(await saveCoachTextAction("instructions", "Be brief.")).toEqual(NOT_ADMIN);
  as(USER);
  expect(await saveCoachTextAction("tool.delete_everything", "x")).toEqual({ ok: false, error: "Unknown text." });
  expect((await saveCoachTextAction("tool.get_day", "   ")).ok).toBe(false);
  expect((await saveCoachTextAction("tool.get_day", "x".repeat(601))).ok).toBe(false);
  expect(await saveCoachTextAction("tool.get_day", "  One day's numbers.  ")).toEqual(DONE);
  expect(await saveCoachTextAction("tool.get_day", "Back again.")).toEqual(DONE);
  expect((await coachTexts(db))("tool.get_day")).toBe("Back again.");
  expect((await textHistory(db)).map((v) => v.body)).toEqual(["Back again.", "One day's numbers."]);
});

it("coach access: only admins set the mode or pick accounts, and owners aren't changed", async () => {
  as(member);
  expect(await setCoachModeAction("everyone")).toEqual(NOT_ADMIN);
  expect(await setCoachAllowedAction(member, true)).toEqual(NOT_ADMIN);
  expect(await coachMode(db)).toBe("off");
  as(USER);
  expect(await setCoachModeAction("chosen")).toEqual(DONE);
  expect(await coachMode(db)).toBe("chosen");
  expect((await setCoachModeAction("all" as never)).ok).toBe(false);
  expect(await setCoachAllowedAction(member, true)).toEqual(DONE);
  expect(await coachAccess(db, member)).toBe(true);
  expect(await setCoachAllowedAction(owner, false)).toEqual({ ok: false, error: "Unknown account." });
  expect(await coachAccess(db, owner)).toBe(true);
});
