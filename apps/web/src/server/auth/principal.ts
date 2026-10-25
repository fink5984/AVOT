import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "../db";
import { sha256Hex } from "../crypto";
import { AppError, forbidden } from "../errors";
import { can, type Permission } from "./permissions";
import { resolveSessionToken, SESSION_COOKIE, type SessionUser } from "./session";

export type UserPrincipal = SessionUser & { kind: "user" };
export interface DevicePrincipal {
  kind: "device";
  deviceId: string;
  organizationId: string;
  deviceName: string;
}
export type Principal = UserPrincipal | DevicePrincipal;

/** Current user for Server Components (memoised per request). */
export const getCurrentUser = cache(async (): Promise<UserPrincipal | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const user = await resolveSessionToken(token);
  return user ? { ...user, kind: "user" } : null;
});

/** For pages: redirect to login when signed out, 403 page when not permitted. */
export async function requirePageUser(permission?: Permission): Promise<UserPrincipal> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (permission && !can(user.role, permission)) redirect("/?denied=1");
  return user;
}

/** For API route handlers. Accepts a session cookie or a device bearer token. */
export async function authenticate(req: Request, opts: { allowDevice?: boolean } = {}): Promise<Principal> {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    if (!opts.allowDevice) throw new AppError("UNAUTHENTICATED", "נדרשת התחברות");
    const device = await db.device.findUnique({ where: { tokenHash: sha256Hex(auth.slice(7).trim()) } });
    if (!device || device.revokedAt) throw new AppError("UNAUTHENTICATED", "עמדת הצילום אינה מורשית או בוטלה");
    return { kind: "device", deviceId: device.id, organizationId: device.organizationId, deviceName: device.name };
  }
  const user = await getCurrentUser();
  if (!user) throw new AppError("UNAUTHENTICATED", "נדרשת התחברות");
  return user;
}

export async function authenticateUser(req: Request, permission?: Permission): Promise<UserPrincipal> {
  const p = await authenticate(req);
  if (p.kind !== "user") throw forbidden();
  if (permission && !can(p.role, permission)) throw forbidden();
  return p;
}

export function assertCan(p: Principal, permission: Permission) {
  // devices are only ever allowed to upload captures/heartbeats; specific routes check that explicitly
  if (p.kind === "device") throw forbidden();
  if (!can(p.role, permission)) throw forbidden();
}
