import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../../db";
import { oauthTokens } from "../../db/schema";
import { addUser, freshDb, USER } from "../../testing";
import { authUrl, consumeState, createState, exchangeCode, getAccessToken, GoogleError, hasGrant, LOGIN_SCOPES, missingScopes, revokeGrant, SCOPES } from "./oauth";

const google = { clientId: "cid", clientSecret: "csecret" };
const NOW = Date.parse("2026-10-02T06:00:00Z");
const T = NOW / 1000;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const tokenStub = (...responses: Response[]) => vi.fn<typeof fetch>(async () => responses.shift()!);
/** An ID token as Google's token endpoint returns it; exchangeCode reads it without a signature check. */
const idToken = (claims: Record<string, unknown> = {}) =>
  ["{}", JSON.stringify({ aud: "cid", email: "Me@Example.com", email_verified: true, ...claims }), ""]
    .map((p, i) => (i < 2 ? Buffer.from(p).toString("base64url") : "sig"))
    .join(".");
const sent = (f: { mock: { calls: unknown[][] } }, i = 0) =>
  Object.fromEntries(new URLSearchParams(String((f.mock.calls[i][1] as RequestInit).body)));

let db: Db;
const row = async (userId = USER) => (await db.select().from(oauthTokens).where(eq(oauthTokens.userId, userId)))[0];
const seed = async (o: Partial<typeof oauthTokens.$inferInsert> = {}) =>
  db.insert(oauthTokens).values({ userId: USER, accessToken: "at-old", refreshToken: "rt-old", expiresAt: T + 3600, scope: "s", updatedAt: T, ...o });

beforeEach(async () => {
  db = await freshDb();
});

const expectGoogleError = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GoogleError);
  expect((err as GoogleError).code).toBe(code);
  return err as GoogleError;
};

describe("authUrl", () => {
  it("asks for offline access, the given prompt, sign-in and every Health scope", () => {
    const u = new URL(authUrl({ clientId: "cid", redirectUri: "https://p.example/oauth/callback", state: "st", prompt: "consent" }));
    expect(`${u.origin}${u.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "cid",
      redirect_uri: "https://p.example/oauth/callback",
      response_type: "code",
      scope: [...LOGIN_SCOPES, ...SCOPES].join(" "),
      access_type: "offline",
      prompt: "consent",
      state: "st",
    });
    expect(LOGIN_SCOPES).toEqual(["openid", "email", "profile"]);
    expect(SCOPES).toHaveLength(13);
    // The Google Health scopes Pulse uses: the read scopes behind every screen, and the write scopes Journal › Log needs.
    for (const s of SCOPES) expect(s).toMatch(/^https:\/\/www\.googleapis\.com\/auth\/googlehealth\.\w+\.(readonly|writeonly)$/);
  });
});

describe("state", () => {
  it("is random and valid exactly once", () => {
    const s = createState(1, NOW);
    expect(s).toMatch(/^[\w-]{43}$/);
    expect(createState(1, NOW)).not.toBe(s);
    expect(consumeState(s, 1, NOW + 1000)).toBe(true);
    expect(consumeState(s, 1, NOW + 2000)).toBe(false);
  });

  it("is bound to the user who started the consent", () => {
    const s = createState(1, NOW);
    expect(consumeState(s, 2, NOW + 1000)).toBe(false);
    expect(consumeState(s, 1, NOW + 1000)).toBe(false); // spent by the failed attempt
  });

  it("expires after 10 minutes", () => {
    const fresh = createState(1, NOW);
    const stale = createState(1, NOW);
    expect(consumeState(fresh, 1, NOW + 10 * 60_000 - 1)).toBe(true);
    expect(consumeState(stale, 1, NOW + 10 * 60_000)).toBe(false);
  });

  it("rejects missing, empty and unknown states", () => {
    expect(consumeState(null, 1)).toBe(false);
    expect(consumeState("", 1)).toBe(false);
    expect(consumeState("forged", 1)).toBe(false);
  });
});

describe("exchangeCode", () => {
  /** `f` answers the token endpoint; the Google Health identity check answers `identity` (linked by default). */
  const exchange = (f: typeof globalThis.fetch, identity = () => json(200, { healthUserId: "u" })) =>
    exchangeCode(db, USER, {
      google,
      redirectUri: "https://p.example/oauth/callback",
      code: "c0de",
      fetch: (async (url, init) => (String(url).endsWith("/users/me/identity") ? identity() : f(url, init))) as typeof fetch,
      now: () => NOW,
    });
  const grant = (o: Record<string, unknown> = {}) =>
    json(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, id_token: idToken(), ...o });

  it("posts the code, stores the grant in the user's row and returns the lowercased email", async () => {
    const f = tokenStub(grant({ expires_in: 3599, scope: "a b" }));
    expect(await exchange(f)).toEqual({ email: "me@example.com", picture: null, name: null });
    expect(sent(f)).toEqual({
      code: "c0de",
      client_id: "cid",
      client_secret: "csecret",
      redirect_uri: "https://p.example/oauth/callback",
      grant_type: "authorization_code",
    });
    expect(await row()).toEqual({
      userId: USER,
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: T + 3599,
      scope: "a b",
      revokedAt: null,
      updatedAt: T,
      googleEmail: "me@example.com",
      googleName: null,
      googlePicture: null,
    });
  });

  it("reconnecting replaces the grant and clears a revocation", async () => {
    await seed({ revokedAt: T - 10 });
    await exchange(tokenStub(grant()));
    expect(await row()).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1", revokedAt: null, scope: SCOPES.join(" ") });
    expect(await db.select().from(oauthTokens)).toHaveLength(1);
  });

  it("without a refresh_token and no working grant stores nothing and surfaces auth_revoked", async () => {
    await seed({ revokedAt: T - 10 });
    const before = await row();
    const err = await expectGoogleError(exchange(tokenStub(grant({ refresh_token: undefined }))), "auth_revoked");
    expect(err.message).not.toContain("at-1");
    expect(await row()).toEqual(before);
  });

  it("without a refresh_token (sign-in, no consent screen) updates a working grant's access token only", async () => {
    await seed();
    await exchange(tokenStub(grant({ refresh_token: undefined, expires_in: 100, id_token: idToken({ name: "Ada" }) })));
    expect(await row()).toMatchObject({ accessToken: "at-1", refreshToken: "rt-old", expiresAt: T + 100, revokedAt: null, googleEmail: "me@example.com", googleName: "Ada" });
  });

  it("returns the Google photo from the ID token, https only", async () => {
    const pic = "https://lh3.googleusercontent.com/a/x";
    expect((await exchange(tokenStub(grant({ id_token: idToken({ picture: pic }) })))).picture).toBe(pic);
    expect((await exchange(tokenStub(grant({ id_token: idToken({ picture: "javascript:alert(1)" }) })))).picture).toBeNull();
    expect((await exchange(tokenStub(grant({ id_token: idToken({ name: "  Ada Lovelace " }) })))).name).toBe("Ada Lovelace");
    expect((await row())?.googleName).toBe("Ada Lovelace");
  });

  it("an account without a Google Health profile is refused, storing nothing", async () => {
    const notLinked = () =>
      json(400, { error: { status: "FAILED_PRECONDITION", details: [{ reason: "ACCOUNT_NOT_LINKED", metadata: { redirect_uri: "https://fitbit.google.com/auth/signup" } }] } });
    await expectGoogleError(exchange(tokenStub(grant()), notLinked), "account_not_linked");
    expect(await row()).toBeUndefined();
    // Any other identity failure (Google having a bad day) doesn't block connecting.
    expect((await exchange(tokenStub(grant()), () => json(503, {}))).email).toBe("me@example.com");
  });

  it("an unverified email, a missing ID token or one for another client is refused, storing nothing", async () => {
    await expectGoogleError(exchange(tokenStub(grant({ id_token: idToken({ email_verified: false }) }))), "email_unverified");
    await expectGoogleError(exchange(tokenStub(grant({ id_token: undefined }))), "no_id_token");
    await expectGoogleError(exchange(tokenStub(grant({ id_token: idToken({ aud: "other" }) }))), "no_id_token");
    expect(await row()).toBeUndefined();
  });

  it("a rejected code surfaces Google's code but no body text, and stores nothing", async () => {
    const body = { error: "invalid_grant", error_description: "Bad Request SECRET-DETAIL" };
    const err = await expectGoogleError(exchange(tokenStub(json(400, body))), "invalid_grant");
    expect(err.status).toBe(400);
    expect(JSON.stringify(err) + err.message + err.stack).not.toContain("SECRET-DETAIL");
    expect(await row()).toBeUndefined();
  });

  it("a non-JSON error body falls back to the status", async () => {
    const err = await expectGoogleError(exchange(tokenStub(new Response("<html>SECRET</html>", { status: 502 }))), "http_502");
    expect(err.message).not.toContain("SECRET");
  });
});

describe("revokeGrant", () => {
  it("revokes the refresh token at Google, then forgets the grant", async () => {
    await seed();
    const f = tokenStub(new Response("", { status: 200 }));
    await revokeGrant(db, USER, { fetch: f });
    expect(String(f.mock.calls[0][0])).toBe("https://oauth2.googleapis.com/revoke");
    expect(sent(f)).toEqual({ token: "rt-old" });
    expect(await row()).toBeUndefined();
  });

  it("an already-invalid token (400) still forgets the grant; a 5xx keeps it for a retry", async () => {
    await seed();
    await expectGoogleError(revokeGrant(db, USER, { fetch: tokenStub(new Response("", { status: 503 })) }), "http_503");
    expect(await row()).toBeDefined();
    await revokeGrant(db, USER, { fetch: tokenStub(new Response("", { status: 400 })) });
    expect(await row()).toBeUndefined();
  });
});

describe("getAccessToken", () => {
  const get = (f: typeof fetch, o: { force?: boolean; now?: number } = {}) =>
    getAccessToken(db, USER, google, { fetch: f, now: () => o.now ?? NOW, force: o.force });

  it("returns the stored token while valid, without a request", async () => {
    await seed();
    const f = tokenStub();
    expect(await get(f)).toBe("at-old");
    expect(f.mock.calls).toHaveLength(0);
  });

  it("refreshes within a minute of expiry and stores the new token, keeping an unrotated refresh token", async () => {
    await seed({ expiresAt: T + 59 });
    const f = tokenStub(json(200, { access_token: "at-new", expires_in: 3600 }));
    expect(await get(f)).toBe("at-new");
    expect(sent(f)).toEqual({ client_id: "cid", client_secret: "csecret", refresh_token: "rt-old", grant_type: "refresh_token" });
    expect(await row()).toMatchObject({ accessToken: "at-new", refreshToken: "rt-old", expiresAt: T + 3600, revokedAt: null });
  });

  it("stores a rotated refresh token", async () => {
    await seed({ expiresAt: T - 1 });
    await get(tokenStub(json(200, { access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 })));
    expect((await row())?.refreshToken).toBe("rt-new");
  });

  it("force refreshes a token that is still valid", async () => {
    await seed();
    expect(await get(tokenStub(json(200, { access_token: "at-new", expires_in: 3600 })), { force: true })).toBe("at-new");
  });

  it("invalid_grant marks the token revoked, and later calls fail without a request", async () => {
    await seed({ expiresAt: T - 1 });
    await expectGoogleError(get(tokenStub(json(400, { error: "invalid_grant" }))), "auth_revoked");
    expect((await row())?.revokedAt).toBe(T);
    const f = tokenStub();
    await expectGoogleError(get(f), "auth_revoked");
    expect(f.mock.calls).toHaveLength(0);
  });

  it("a 503 on refresh is not a revocation", async () => {
    await seed({ expiresAt: T - 1 });
    await expectGoogleError(get(tokenStub(json(503, {}))), "http_503");
    expect((await row())?.revokedAt).toBeNull();
  });

  it("a malformed token response is an error, and the old token is kept", async () => {
    await seed({ expiresAt: T - 1 });
    await expectGoogleError(get(tokenStub(json(200, { access_token: "at-new" }))), "bad_token_response");
    expect((await row())?.accessToken).toBe("at-old");
  });

  it("without a grant throws not_connected", async () => {
    await expectGoogleError(get(tokenStub()), "not_connected");
  });

  it("a failed token write surfaces as a code, never the query params holding the tokens", async () => {
    await seed({ refreshToken: "rt-secret", expiresAt: T - 1 });
    // The update is the only write, so a trigger that refuses it stands in for a database failure.
    await db.execute(sql`create function refuse() returns trigger language plpgsql as $$ begin raise exception 'db down'; end $$`);
    await db.execute(sql`create trigger refuse before update on oauth_tokens for each row execute function refuse()`);
    const err = await expectGoogleError(get(tokenStub(json(200, { access_token: "at-secret", expires_in: 3600 }))), "token_store_failed");
    expect(`${err.message} ${err.stack}`).not.toMatch(/at-secret|rt-secret/);
  });
});

describe("missingScopes", () => {
  it("lists the scopes an older grant lacks, nothing for a full grant or no grant", async () => {
    expect(await missingScopes(db, USER)).toEqual([]);
    const old = SCOPES.filter((s) => !s.endsWith(".writeonly") || s.includes(".nutrition."));
    await seed({ scope: ["openid", ...old].join(" ") });
    expect(await missingScopes(db, USER)).toEqual(SCOPES.filter((s) => s.endsWith(".writeonly") && !s.includes(".nutrition.")));
    await db.update(oauthTokens).set({ scope: SCOPES.join(" ") });
    expect(await missingScopes(db, USER)).toEqual([]);
  });
});

describe("per user", () => {
  it("each user's grant is their own: reads, refresh and revoke never touch another's row", async () => {
    const other = await addUser(db);
    await seed();
    expect(await hasGrant(db, USER)).toBe(true);
    expect(await hasGrant(db, other)).toBe(false);
    await expectGoogleError(getAccessToken(db, other, google, { fetch: tokenStub(), now: () => NOW }), "not_connected");
    await revokeGrant(db, other, { fetch: tokenStub() });
    expect(await row()).toBeDefined();
  });
});
