// The admin panel's data: who is an admin, the sign-up mode, the accounts on this server, and sign-up invites.
// Admins are the ADMIN_EMAILS accounts (the owners, set in the environment) plus any account an admin promotes
// (`user.role`). An invite is a one-time link; only its token's SHA-256 is stored.
import { createHash, randomBytes } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, asc, count, desc, eq, gt, isNotNull, isNull, max, sql } from "drizzle-orm";
import { getConfig } from "./config";
import type { Db } from "./db";
import { account, coachSettings, invites, oauthTokens, serverSettings, session, user } from "./db/schema";
import { revokeGrant } from "./sources/google/oauth";

export const INVITE_DAYS = 7;
const now = () => Math.floor(Date.now() / 1000);
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * An ADMIN_EMAILS address: an owner, always an admin, never changed or deleted from the panel. Such an address can
 * only sign up on a server with no accounts (auth.ts), so listing an email never lets a stranger claim it.
 */
export const isOwnerEmail = (email: string) => getConfig().adminEmails.includes(email.toLowerCase());

export async function isAdmin(db: Db, userId: number): Promise<boolean> {
  const [u] = await db.select({ role: user.role, email: user.email }).from(user).where(eq(user.id, userId));
  return !!u && (u.role === "admin" || isOwnerEmail(u.email));
}

export async function userCount(db: Db): Promise<number> {
  const [r] = await db.select({ n: count() }).from(user);
  return r.n;
}

// ── Sign-up mode ─────────────────────────────────────────────────────────────

export const SIGNUP_MODES = ["invite", "open", "closed"] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

/** The admin panel's choice, else SIGNUP from the environment. */
export async function signupMode(db: Db): Promise<SignupMode> {
  const [r] = await db.select({ value: serverSettings.value }).from(serverSettings).where(eq(serverSettings.key, "signup"));
  return SIGNUP_MODES.find((m) => m === r?.value) ?? getConfig().signup;
}

export async function setSignupMode(db: Db, mode: SignupMode): Promise<void> {
  await db
    .insert(serverSettings)
    .values({ key: "signup", value: mode })
    .onConflictDoUpdate({ target: serverSettings.key, set: { value: mode } });
}

// ── Invites ──────────────────────────────────────────────────────────────────

/** A new invite; returns the token, which is shown once (the link is `/signup?invite=<token>`). */
export async function createInvite(db: Db, createdBy: number, label: string | null): Promise<string> {
  const token = randomBytes(18).toString("base64url");
  const at = now();
  await db.insert(invites).values({ tokenHash: hash(token), label, createdBy, createdAt: at, expiresAt: at + INVITE_DAYS * 86_400 });
  return token;
}

const usable = (token: string) => and(eq(invites.tokenHash, hash(token)), isNull(invites.usedAt), gt(invites.expiresAt, now()));

/** Whether a token can still be used: not used, not expired, not revoked (a revoked invite is deleted). */
export async function inviteValid(db: Db, token: string): Promise<boolean> {
  const [r] = await db.select({ id: invites.id }).from(invites).where(usable(token));
  return !!r;
}

/** Uses up an invite, atomically: two sign-ups racing on one link get it once. False when it can't be used. */
export async function claimInvite(db: Db, token: string): Promise<boolean> {
  const r = await db.update(invites).set({ usedAt: now() }).where(usable(token)).returning({ id: invites.id });
  return r.length === 1;
}

/** Records which account a just-claimed invite made; never rewrites an invite already recorded. */
export async function inviteUsedBy(db: Db, token: string, userId: number): Promise<void> {
  await db
    .update(invites)
    .set({ usedBy: userId })
    .where(and(eq(invites.tokenHash, hash(token)), isNotNull(invites.usedAt), isNull(invites.usedBy)));
}

/** Deletes an unused invite, so its link stops working. */
export async function revokeInvite(db: Db, id: number): Promise<void> {
  await db.delete(invites).where(and(eq(invites.id, id), isNull(invites.usedAt)));
}

export type InviteRow = { id: number; label: string | null; createdAt: number; expiresAt: number; usedAt: number | null; usedBy: string | null };

/** Unused invites (newest first, expired ones too until revoked), then the 20 most recently used. */
export async function listInvites(db: Db): Promise<InviteRow[]> {
  const rows = await db
    .select({
      id: invites.id,
      label: invites.label,
      createdAt: invites.createdAt,
      expiresAt: invites.expiresAt,
      usedAt: invites.usedAt,
      usedBy: sql<string | null>`coalesce(${user.username}, ${user.name})`,
    })
    .from(invites)
    .leftJoin(user, eq(user.id, invites.usedBy))
    .orderBy(desc(sql`coalesce(${invites.usedAt}, ${invites.createdAt})`));
  return [...rows.filter((r) => r.usedAt === null), ...rows.filter((r) => r.usedAt !== null).slice(0, 20)];
}

// ── Accounts ─────────────────────────────────────────────────────────────────

export type AccountRow = {
  id: number;
  name: string;
  username: string | null;
  email: string;
  /** `owner`: listed in ADMIN_EMAILS. */
  role: "user" | "admin" | "owner";
  createdAt: Date;
  /** Latest session activity; null when the account has no live session. */
  lastSeen: Date | null;
  /** Devices signed in right now (live sessions). */
  sessions: number;
  google: boolean;
  /** Picked for the coach by an admin (matters when Coach = chosen accounts). */
  coachAllowed: boolean;
  /** Has allowed the coach and picked a provider (never which key). */
  coachReady: boolean;
};

/** Every account, oldest first, with no health data: who they are, when they were last active, whether Google is connected. */
export async function listAccounts(db: Db): Promise<AccountRow[]> {
  const seen = db.select({ userId: session.userId, at: max(session.updatedAt).as("at"), n: count().as("n") }).from(session).groupBy(session.userId).as("seen");
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      role: user.role,
      coachAllowed: user.coachAllowed,
      coachReady: sql<boolean>`${coachSettings.consentAt} is not null and ${coachSettings.provider} is not null`,
      createdAt: user.createdAt,
      lastSeen: seen.at,
      sessions: sql<number>`coalesce(${seen.n}, 0)::int`,
      google: sql<boolean>`${oauthTokens.userId} is not null and ${oauthTokens.revokedAt} is null`,
    })
    .from(user)
    .leftJoin(seen, eq(seen.userId, user.id))
    .leftJoin(oauthTokens, eq(oauthTokens.userId, user.id))
    .leftJoin(coachSettings, eq(coachSettings.userId, user.id))
    .orderBy(asc(user.id));
  return rows.map((r) => ({ ...r, role: isOwnerEmail(r.email) ? "owner" : r.role }));
}

export async function setRole(db: Db, userId: number, role: "user" | "admin"): Promise<void> {
  await db.update(user).set({ role }).where(eq(user.id, userId));
}

/** Signs an account out on every device (its sessions are deleted). Returns how many there were. */
export async function signOutEverywhere(db: Db, userId: number): Promise<number> {
  return (await db.delete(session).where(eq(session.userId, userId)).returning({ id: session.id })).length;
}

/**
 * Sets a temporary password (16 random characters) and signs the account out everywhere, as
 * scripts/reset-password.mjs does. Returns the password, shown once to the owner who reset it.
 */
export async function resetPassword(db: Db, userId: number): Promise<string> {
  const temp = randomBytes(12).toString("base64url");
  const hash = await hashPassword(temp);
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(account)
      .set({ password: hash, updatedAt: new Date() })
      .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
      .returning({ id: account.id });
    if (!updated.length) await tx.insert(account).values({ accountId: String(userId), providerId: "credential", userId, password: hash, updatedAt: new Date() });
    await tx.delete(session).where(eq(session.userId, userId));
  });
  return temp;
}

/** Deletes an account and, through the cascades, all its data and sessions. Refuses admins: demote first. */
export async function deleteAccount(db: Db, userId: number): Promise<"ok" | "admin"> {
  if (await isAdmin(db, userId)) return "admin";
  await revokeGrant(db, userId); // the cascade only forgets the Google token; revoke it there first
  await db.delete(user).where(eq(user.id, userId));
  return "ok";
}
