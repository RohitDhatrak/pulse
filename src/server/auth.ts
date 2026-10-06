// Accounts and sessions (better-auth on Postgres through the Drizzle adapter). People sign up with a name, a username
// and an email (with an admin's invite link while sign-up is invite-only), then sign in with the username or the email.
// Pages, Server Actions and route handlers each look the session up themselves: the proxy only checks that a session
// cookie exists.
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { nextCookies } from "better-auth/next-js";
import { username } from "better-auth/plugins";
import { headers } from "next/headers";
import { cache } from "react";
import { claimInvite, inviteUsedBy, isOwnerEmail, signupMode, userCount } from "./admin";
import { getConfig } from "./config";
import { type Db, getDb } from "./db";
import * as schema from "./db/schema";
import { DEMO_EMAIL, DEMO_SECRET } from "./demo";
import { ensureDefaultTags } from "./journalTags";
import { revokeGrant } from "./sources/google/oauth";

export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 128;
export const USERNAME_RE = /^[a-z0-9_.]{3,30}$/;
/** The sign-up form sends the invite token in this header (the sign-up body has a fixed shape). */
export const INVITE_HEADER = "x-pulse-invite";

const DEMO_LOCKED = new Set(["/change-password", "/change-email", "/update-user", "/delete-user", "/revoke-session", "/revoke-sessions", "/revoke-other-sessions"]);

function createAuth(db: Db) {
  const cfg = getConfig();
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema }),
    // A demo instance holds only generated data, so a fixed secret is fine there; a real one must set its own
    // (config.ts refuses to start in production without it).
    secret: cfg.authSecret ?? (cfg.dataSource === "google" ? undefined : DEMO_SECRET),
    ...(cfg.appUrl && { baseURL: cfg.appUrl, trustedOrigins: [cfg.appUrl] }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD,
      maxPasswordLength: MAX_PASSWORD,
      // A demo instance has one shared demo user and no sign-up. A real one asks signupMode (admin panel) per sign-up.
      disableSignUp: cfg.dataSource !== "google",
      autoSignIn: true,
      revokeSessionsOnPasswordReset: true,
    },
    user: {
      deleteUser: {
        enabled: true,
        // Revoke at Google first (as Disconnect does): the cascade only forgets the token, it stays valid there.
        // A network failure throws, so the account stays and the person can retry.
        beforeDelete: async (u) => {
          await revokeGrant(db, Number(u.id));
        },
      },
    },
    // The shared demo account's password is public: visitors must not change it, delete it or end each other's sessions.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!DEMO_LOCKED.has(ctx.path)) return;
        if ((await getSessionFromCtx(ctx))?.user.email === DEMO_EMAIL)
          throw new APIError("FORBIDDEN", { message: "The demo account can't be changed.", code: "DEMO_LOCKED" });
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // The sign-up mode, checked as the account is about to be made (after better-auth's own checks), for every
          // caller, HTTP or not:
          // - An ADMIN_EMAILS address may sign up only while the server has no accounts: that is how the owner
          //   starts a new server, right after deploying (docs/setup.md). Emails aren't verified, so later it is
          //   refused outright; otherwise anyone could claim a listed address that has no account yet and become an
          //   owner. A later owner signs up like anyone, then is added to ADMIN_EMAILS.
          // - closed: nobody else.
          // - invite: an unused invite link in the x-pulse-invite header.
          before: async (u, ctx) => {
            if (isOwnerEmail(u.email)) {
              if ((await userCount(db)) === 0) return;
              throw new APIError("FORBIDDEN", { message: "This email is reserved for an admin of this server.", code: "OWNER_EMAIL_RESERVED" });
            }
            const mode = await signupMode(db);
            if (mode === "closed") throw new APIError("BAD_REQUEST", { message: "Sign-up is closed on this server.", code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" });
            if (mode === "open") return;
            const token = ctx?.headers?.get(INVITE_HEADER);
            if (!token || !(await claimInvite(db, token)))
              throw new APIError("FORBIDDEN", { message: "This invite link is used, expired or revoked.", code: "INVITE_INVALID" });
          },
          // A new account starts with the default journal behaviours; its data rows go with it on delete (FK cascade).
          after: async (u, ctx) => {
            const id = Number(u.id);
            await ensureDefaultTags(db, id);
            const token = ctx?.headers?.get(INVITE_HEADER);
            if (token) await inviteUsedBy(db, token, id); // only an invite this sign-up claimed (usedBy still null)
          },
        },
      },
    },
    // No cookie cache: every request checks the session row (one indexed lookup), so a sign-out, password change or
    // deleted account takes effect at once on every device.
    session: { expiresIn: 30 * 86_400, updateAge: 86_400 },
    rateLimit: {
      enabled: process.env.NODE_ENV !== "test",
      storage: "database",
      customRules: {
        "/sign-in/*": { window: 60, max: 5 },
        "/sign-up/*": { window: 3600, max: 10 },
        "/change-password": { window: 600, max: 5 },
      },
    },
    advanced: {
      // Behind Cloudflare Tunnel, the tunnel sets the client IP and overwrites any the client sent.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
      database: { generateId: "serial" },
    },
    plugins: [
      username({ minUsernameLength: 3, maxUsernameLength: 30, usernameValidator: (u) => USERNAME_RE.test(u.toLowerCase()) }), // stored lowercase
      nextCookies(), // last: lets Server Actions set the session cookie
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

// Per database, so a test that swaps the database (setDb) gets an auth bound to it.
const g = globalThis as typeof globalThis & { __pulseAuth?: { db: Db; auth: Auth } };

export function getAuth(): Auth {
  const db = getDb();
  if (g.__pulseAuth?.db !== db) g.__pulseAuth = { db, auth: createAuth(db) };
  return g.__pulseAuth.auth;
}

export type SessionUser = { userId: number; email: string; name: string; username: string | null; image: string | null };

function toUser(s: Awaited<ReturnType<Auth["api"]["getSession"]>>): SessionUser | null {
  if (!s) return null;
  const u = s.user as typeof s.user & { username?: string | null };
  return { userId: Number(u.id), email: u.email, name: u.name, username: u.username ?? null, image: u.image ?? null };
}

/** The signed-in user for a Server Component or Server Action, or null. Once per request (layout and page share it). */
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  // Headers first: during `next build` this throws (the page is dynamic) before better-auth is ever created.
  const h = await headers();
  return toUser(await getAuth().api.getSession({ headers: h }));
});

/** The signed-in user for a route handler, from the request's own headers. */
export async function requestUser(req: Request): Promise<SessionUser | null> {
  return toUser(await getAuth().api.getSession({ headers: req.headers }));
}

export const SIGNED_OUT = { ok: false as const, error: "Signed out. Sign in again." };

// ── Demo instance ────────────────────────────────────────────────────────────
// The demo user's credentials live in ./demo (no Next imports), so scripts and the seed can use them.
export { DEMO_EMAIL, DEMO_PASSWORD } from "./demo";
