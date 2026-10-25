import "server-only";
import { cookies } from "next/headers";
import { db } from "../db";
import { randomToken, sha256Hex } from "../crypto";
import { env } from "../env";

export const SESSION_COOKIE = "avot_session";
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface SessionUser {
  sessionId: string;
  userId: string;
  organizationId: string;
  name: string;
  email: string;
  role: "ADMIN" | "EDITOR" | "PHOTOGRAPHER" | "WAREHOUSE" | "VIEWER";
  /** auction houses whose commercial data the user may see; null = all */
  houseIds: string[] | null;
}

function cookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env().APP_URL.startsWith("https://"),
    path: "/",
    expires,
  };
}

export async function createSession(userId: string, meta: { ip?: string | null; userAgent?: string | null }) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({
    data: {
      userId,
      tokenHash: sha256Hex(token),
      expiresAt,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
    },
  });
  await db.user.update({ where: { id: userId }, data: { lastActiveAt: new Date() } });
  (await cookies()).set(SESSION_COOKIE, token, cookieOptions(expiresAt));
}

/** Resolves a raw session token to an active user, sliding the expiry. */
export async function resolveSessionToken(token: string | undefined): Promise<SessionUser | null> {
  if (!token || token.length > 200) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { user: { include: { houseAccess: { select: { auctionHouseId: true } } } } },
  });
  if (!session || session.expiresAt < new Date() || session.user.status !== "ACTIVE") return null;

  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.$transaction([
      db.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(), expiresAt } }),
      db.user.update({ where: { id: session.userId }, data: { lastActiveAt: new Date() } }),
    ]);
  }
  return {
    sessionId: session.id,
    userId: session.user.id,
    organizationId: session.user.organizationId,
    name: session.user.name,
    email: session.user.email,
    role: session.user.role,
    // admins always see every house; an empty access list means "all houses"
    houseIds: session.user.role === "ADMIN" || session.user.houseAccess.length === 0 ? null : session.user.houseAccess.map((h) => h.auctionHouseId),
  };
}

export async function destroyCurrentSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.session.deleteMany({ where: { tokenHash: sha256Hex(token) } });
  jar.delete(SESSION_COOKIE);
}

export async function destroyAllSessionsForUser(userId: string) {
  await db.session.deleteMany({ where: { userId } });
}
