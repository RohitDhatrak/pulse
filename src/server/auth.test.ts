// better-auth on Postgres (PGlite): sign-up, sign-in by email and by username, the failures, and delete account
// taking every row of the user's data with it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { desc, eq, isNull } from "drizzle-orm";
import { createInvite, deleteAccount, inviteValid, isAdmin, revokeInvite, setSignupMode, signupMode } from "./admin";
import { getAuth, INVITE_HEADER } from "./auth";
import { parseConfig, type Config } from "./config";
import { type Db, rows, sql } from "./db";
import { invites, profile, user } from "./db/schema";
import { DEMO_EMAIL, DEMO_PASSWORD } from "./demo";
import { ensureDemoUser, seedPull } from "./sources/seed/generate";
import { freshDb, NOW, TZ, USER } from "./testing";

// Sign-up is closed on a demo instance, so these run as a Google instance.
const h = vi.hoisted(() => ({ cfg: undefined as unknown }));
vi.mock("@/server/config", async (orig) => ({ ...(await orig<object>()), getConfig: () => h.cfg as Config }));
vi.mock("./config", async (orig) => ({ ...(await orig<object>()), getConfig: () => h.cfg as Config }));
// Open sign-up: these test better-auth itself; the invite gate has its own tests in auth.test.ts.
const googleCfg = parseConfig({ DATA_SOURCE: "google", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "cs", SIGNUP: "open" });

const ADA = { name: "Ada Lovelace", email: "ada@example.com", password: "analytical-engine", username: "ada.l" };

/** The APIError code a call fails with, or "ok". */
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { body?: { code?: string } }) => e.body?.code ?? String(e),
  );

/** Signs in and returns request headers carrying the session cookie. */
async function signedIn(email: string, password: string) {
  const res = await getAuth().api.signInEmail({ body: { email, password }, asResponse: true });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return new Headers({ cookie });
}

let db: Db;
beforeEach(async () => {
  h.cfg = googleCfg;
  db = await freshDb();
});

describe("better-auth", () => {
  it("signs up, then signs in with the email or the username", async () => {
    const up = await getAuth().api.signUpEmail({ body: ADA });
    expect(up.user).toMatchObject({ email: ADA.email, name: ADA.name, username: "ada.l" });
    expect(Number(up.user.id)).toBeGreaterThan(USER);

    const byEmail = await getAuth().api.signInEmail({ body: { email: ADA.email, password: ADA.password } });
    expect(byEmail.user.email).toBe(ADA.email);
    const byName = await getAuth().api.signInUsername({ body: { username: "ada.l", password: ADA.password } });
    expect(byName?.user.email).toBe(ADA.email);
  });

  it("refuses a wrong password, an unknown account, and sign-up with a taken username or email", async () => {
    await getAuth().api.signUpEmail({ body: ADA });
    expect(await codeOf(getAuth().api.signInEmail({ body: { email: ADA.email, password: "wrong-password" } }))).toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(await codeOf(getAuth().api.signInUsername({ body: { username: "ada.l", password: "wrong-password" } }))).toBe("INVALID_USERNAME_OR_PASSWORD");
    expect(await codeOf(getAuth().api.signInEmail({ body: { email: "nobody@example.com", password: ADA.password } }))).toBe("INVALID_EMAIL_OR_PASSWORD");

    expect(await codeOf(getAuth().api.signUpEmail({ body: { ...ADA, email: "other@example.com" } }))).toBe("USERNAME_IS_ALREADY_TAKEN");
    expect(await codeOf(getAuth().api.signUpEmail({ body: { ...ADA, username: "ada.other" } }))).toMatch(/^USER_ALREADY_EXISTS/);
    expect(await codeOf(getAuth().api.signUpEmail({ body: { ...ADA, email: "short@example.com", username: "shorty", password: "too-short" } }))).toBe(
      "PASSWORD_TOO_SHORT",
    );
  });

  it("stores usernames in lowercase, signs in case-insensitively, and refuses invalid ones", async () => {
    const up = await getAuth().api.signUpEmail({ body: { ...ADA, username: "Ada.L" } });
    expect(up.user).toMatchObject({ username: "ada.l" });
    expect((await getAuth().api.signInUsername({ body: { username: "ADA.L", password: ADA.password } }))?.user.email).toBe(ADA.email);
    // Taken regardless of case.
    expect(await codeOf(getAuth().api.signUpEmail({ body: { ...ADA, email: "b@example.com", username: "ADA.l" } }))).toBe("USERNAME_IS_ALREADY_TAKEN");
    for (const username of ["ab", "has space", "dash-ed", "x".repeat(31)]) {
      expect(await codeOf(getAuth().api.signUpEmail({ body: { ...ADA, email: `${username.length}@example.com`, username } })), username).not.toBe("ok");
    }
  });

  it("delete account removes the user and every row of their data, and nobody else's", async () => {
    const id = Number((await getAuth().api.signUpEmail({ body: ADA })).user.id);
    await seedPull(db, { userId: id, now: NOW, timeZone: TZ, maxHr: 183 });
    await db.insert(profile).values({ userId: id, birthDate: "1990-01-01", sex: "female", timeZone: TZ, updatedAt: 0 });
    await db.insert(profile).values({ userId: USER, birthDate: "1990-01-01", sex: "male", timeZone: TZ, updatedAt: 0 });

    const tables = (
      await rows<{ table_name: string }>(db, sql`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'user_id' order by 1`)
    ).map((r) => r.table_name);
    const counts = async (userId: number) => {
      const out: Record<string, number> = {};
      for (const t of tables) out[t] = (await rows<{ n: number }>(db, sql`select count(*)::int as n from ${sql.identifier(t)} where user_id = ${userId}`))[0].n;
      return out;
    };
    const before = await counts(id);
    // The seed, the sign-up and the default journal tags reached a good spread of tables.
    expect(Object.values(before).filter((n) => n > 0).length).toBeGreaterThanOrEqual(5);
    for (const t of ["session", "account", "profile", "journal_tags"]) expect(before[t], t).toBeGreaterThan(0);

    const headers = await signedIn(ADA.email, ADA.password);
    expect(await codeOf(getAuth().api.deleteUser({ body: { password: "wrong-password" }, headers }))).toBe("INVALID_PASSWORD");
    await getAuth().api.deleteUser({ body: { password: ADA.password }, headers });

    expect(Object.entries(await counts(id)).filter(([, n]) => n > 0)).toEqual([]);
    expect(await rows(db, sql`select id from "user" where id = ${id}`)).toEqual([]);
    expect((await counts(USER)).profile).toBe(1);
    expect(await codeOf(getAuth().api.signInEmail({ body: { email: ADA.email, password: ADA.password } }))).toBe("INVALID_EMAIL_OR_PASSWORD");
  });

  it("sign-up is closed on a demo instance and with DISABLE_SIGNUP", async () => {
    for (const cfg of [parseConfig({}), parseConfig({ DATA_SOURCE: "google", GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", DISABLE_SIGNUP: "true" })]) {
      h.cfg = cfg;
      db = await freshDb(); // a new auth instance reads the config
      expect(await codeOf(getAuth().api.signUpEmail({ body: ADA }))).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
    }
  });

  it("the shared demo account can't change its password, delete itself or end other visitors' sessions", async () => {
    h.cfg = parseConfig({});
    db = await freshDb();
    await ensureDemoUser(db);
    const headers = await signedIn(DEMO_EMAIL, DEMO_PASSWORD);
    const api = getAuth().api;
    expect(await codeOf(api.changePassword({ headers, body: { currentPassword: DEMO_PASSWORD, newPassword: "attacker-chosen-pw", revokeOtherSessions: true } }))).toBe("DEMO_LOCKED");
    expect(await codeOf(api.deleteUser({ headers, body: {} }))).toBe("DEMO_LOCKED");
    expect(await codeOf(api.revokeOtherSessions({ headers }))).toBe("DEMO_LOCKED");
    await signedIn(DEMO_EMAIL, DEMO_PASSWORD); // the next visitor still gets in
  });
});

/** A sign-up over HTTP, as the browser makes it: the status and better-auth's error code. */
async function httpSignUp(body: typeof ADA, invite?: string) {
  const res = await getAuth().handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", ...(invite && { [INVITE_HEADER]: invite }) },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, code: res.ok ? null : ((await res.json()) as { code?: string }).code };
}

describe("sign-up modes and invites", () => {
  const BOB = { ...ADA, email: "bob@example.com", username: "bob" };
  const ownerCfg = parseConfig({ DATA_SOURCE: "google", GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", ADMIN_EMAILS: "Ada@Example.com" });
  beforeEach(async () => {
    h.cfg = parseConfig({ DATA_SOURCE: "google", GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s" }); // SIGNUP defaults to invite
    db = await freshDb();
  });

  it("invite-only (the default): no link or a bad one is refused, over HTTP and from server code alike", async () => {
    expect(await signupMode(db)).toBe("invite");
    expect(await codeOf(getAuth().api.signUpEmail({ body: ADA }))).toBe("INVITE_INVALID");
  });

  it("a used invite's record is never rewritten by a later sign-up sending the same token", async () => {
    const token = await createInvite(db, USER, null);
    expect((await httpSignUp(ADA, token)).status).toBe(200);
    await setSignupMode(db, "open");
    expect((await httpSignUp(BOB, token)).status).toBe(200);
    const [inv] = await db.select().from(invites);
    expect(inv.usedBy).toBe((await db.select().from(user).where(eq(user.email, ADA.email)))[0].id);
  });

  it("an ADMIN_EMAILS address can't sign up once the server has accounts, in any mode, invite or not", async () => {
    h.cfg = ownerCfg;
    db = await freshDb(); // has the test user
    const token = await createInvite(db, USER, null);
    expect(await httpSignUp(ADA, token)).toEqual({ status: 403, code: "OWNER_EMAIL_RESERVED" });
    await setSignupMode(db, "open");
    expect(await httpSignUp(ADA)).toEqual({ status: 403, code: "OWNER_EMAIL_RESERVED" });
    expect(await inviteValid(db, token)).toBe(true); // not used up by the refusal
  });

  it("an account deleted from the admin panel is signed out everywhere at once", async () => {
    await setSignupMode(db, "open");
    expect((await httpSignUp(ADA)).status).toBe(200);
    const headers = await signedIn(ADA.email, ADA.password);
    const [ada] = await db.select().from(user).where(eq(user.email, ADA.email));
    expect((await getAuth().api.getSession({ headers }))?.user.email).toBe(ADA.email);
    expect(await deleteAccount(db, ada.id)).toBe("ok");
    expect(await getAuth().api.getSession({ headers })).toBeNull();
  });

  it("`role` sent to sign-up or update-user is ignored: nobody makes themselves admin", async () => {
    await setSignupMode(db, "open");
    expect((await httpSignUp({ ...ADA, role: "admin" } as typeof ADA)).status).toBe(200);
    const headers = await signedIn(ADA.email, ADA.password);
    headers.set("content-type", "application/json");
    headers.set("origin", "http://localhost:3000");
    await getAuth().handler(new Request("http://localhost:3000/api/auth/update-user", { method: "POST", headers, body: JSON.stringify({ name: "Ada", role: "admin" }) }));
    const [ada] = await db.select().from(user).where(eq(user.email, ADA.email));
    expect(ada.role).toBe("user");
    expect(await isAdmin(db, ada.id)).toBe(false);
  });

  it("invite-only: no link or a bad one is refused; a link works once and records who used it", async () => {
    expect(await httpSignUp(ADA)).toEqual({ status: 403, code: "INVITE_INVALID" });
    expect(await httpSignUp(ADA, "made-up")).toEqual({ status: 403, code: "INVITE_INVALID" });

    const token = await createInvite(db, USER, "Ada");
    expect(await inviteValid(db, token)).toBe(true);
    expect(await httpSignUp(ADA, token)).toEqual({ status: 200, code: null });
    expect(await inviteValid(db, token)).toBe(false);
    expect(await httpSignUp(BOB, token)).toEqual({ status: 403, code: "INVITE_INVALID" });

    const [used] = await db.select().from(invites);
    expect(used.usedBy).toBe(Number((await db.select().from(user).where(eq(user.email, ADA.email)))[0].id));
  });

  it("an expired or revoked invite is refused", async () => {
    const expired = await createInvite(db, USER, null);
    await db.update(invites).set({ expiresAt: Math.floor(Date.now() / 1000) - 1 });
    expect(await httpSignUp(ADA, expired)).toEqual({ status: 403, code: "INVITE_INVALID" });

    const revoked = await createInvite(db, USER, null);
    const [row] = await db.select().from(invites).where(isNull(invites.usedAt)).orderBy(desc(invites.id)).limit(1);
    await revokeInvite(db, row.id);
    expect(await httpSignUp(ADA, revoked)).toEqual({ status: 403, code: "INVITE_INVALID" });
  });

  it("on a server with no accounts, an ADMIN_EMAILS address signs up without an invite, even while closed, and is an admin", async () => {
    h.cfg = ownerCfg;
    db = await freshDb();
    await db.delete(user); // a new server
    await setSignupMode(db, "closed");
    expect(await httpSignUp(ADA)).toEqual({ status: 200, code: null });
    const [ada] = await db.select().from(user).where(eq(user.email, ADA.email));
    expect(await isAdmin(db, ada.id)).toBe(true);
    expect(await httpSignUp(BOB)).toEqual({ status: 400, code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" });
  });

  it("the admin panel's mode wins over SIGNUP: open lets anyone in, closed refuses even server calls", async () => {
    await setSignupMode(db, "open");
    expect(await signupMode(db)).toBe("open");
    expect(await httpSignUp(ADA)).toEqual({ status: 200, code: null });
    await setSignupMode(db, "closed");
    expect(await httpSignUp(BOB)).toEqual({ status: 400, code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" });
    expect(await codeOf(getAuth().api.signUpEmail({ body: BOB }))).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
  });
});
