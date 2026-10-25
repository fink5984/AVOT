import "server-only";
import { z } from "zod";
import { ROLES } from "@avot/shared";
import { db } from "../db";
import { randomToken, sha256Hex } from "../crypto";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import { env } from "../env";
import type { UserPrincipal } from "../auth/principal";
import { hashPassword, passwordProblem } from "../auth/password";
import { destroyAllSessionsForUser } from "../auth/session";

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const RESET_TTL_MS = 2 * 3600 * 1000;

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("כתובת אימייל לא תקינה"),
  name: z.string().trim().min(1, "שם נדרש").max(100),
  role: z.enum(ROLES),
});

/**
 * Creates an invitation link. No mail service is configured in this
 * deployment, so the link is returned to the admin to deliver personally.
 */
export async function inviteUser(admin: UserPrincipal, input: z.infer<typeof inviteSchema>) {
  const existing = await db.user.findUnique({ where: { email: input.email } });
  if (existing) throw new AppError("CONFLICT", "משתמש עם אימייל זה כבר קיים");
  const token = randomToken(24);
  await db.invite.create({
    data: {
      organizationId: admin.organizationId,
      email: input.email,
      name: input.name,
      role: input.role,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      createdById: admin.userId,
    },
  });
  await audit(admin, { action: "user.invited", entityType: "user", data: { email: input.email, role: input.role } });
  return { url: `${env().APP_URL}/invite/${token}`, expiresInDays: 7 };
}

export async function findInvite(token: string) {
  const invite = await db.invite.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) return null;
  return invite;
}

export async function acceptInvite(token: string, password: string) {
  const problem = passwordProblem(password);
  if (problem) throw new AppError("VALIDATION", problem);
  const invite = await findInvite(token);
  if (!invite) throw new AppError("NOT_FOUND", "ההזמנה אינה בתוקף");
  const passwordHash = await hashPassword(password);
  return db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { organizationId: invite.organizationId, email: invite.email, name: invite.name, role: invite.role, passwordHash, status: "ACTIVE" },
    });
    await tx.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
    await tx.auditLog.create({
      data: { organizationId: invite.organizationId, userId: user.id, action: "user.invite_accepted", entityType: "user", entityId: user.id },
    });
    return user;
  });
}

export const userUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  role: z.enum(ROLES).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  /** auction houses whose commercial data the user may access; [] = all houses */
  houseIds: z.array(z.string().uuid()).max(20).optional(),
});

export async function updateUser(admin: UserPrincipal, id: string, input: z.infer<typeof userUpdateSchema>) {
  const user = await db.user.findFirst({ where: { id, organizationId: admin.organizationId } });
  if (!user) throw notFound("המשתמש");
  if (id === admin.userId && (input.role && input.role !== "ADMIN" || input.status === "DISABLED")) {
    throw new AppError("VALIDATION", "לא ניתן להסיר הרשאות ניהול או להשבית את המשתמש שלך");
  }
  if (user.role === "ADMIN" && (input.role && input.role !== "ADMIN" || input.status === "DISABLED")) {
    const admins = await db.user.count({ where: { organizationId: admin.organizationId, role: "ADMIN", status: "ACTIVE" } });
    if (admins <= 1) throw new AppError("VALIDATION", "חייב להישאר לפחות מנהל מערכת פעיל אחד");
  }
  const { houseIds, ...fields } = input;
  if (houseIds) {
    const valid = await db.auctionHouse.count({ where: { id: { in: houseIds }, organizationId: admin.organizationId } });
    if (valid !== new Set(houseIds).size) throw notFound("בית המכירות");
  }
  const updated = await db.$transaction(async (tx) => {
    const u = await tx.user.update({ where: { id }, data: fields });
    if (houseIds) {
      await tx.userHouseAccess.deleteMany({ where: { userId: id } });
      if (houseIds.length) await tx.userHouseAccess.createMany({ data: houseIds.map((auctionHouseId) => ({ userId: id, auctionHouseId })) });
    }
    return u;
  });
  // role / house scope changes apply on the next request (sessions re-read them); disabling ends sessions
  if (input.status === "DISABLED") await destroyAllSessionsForUser(id);
  await audit(admin, { action: "user.updated", entityType: "user", entityId: id, data: input as object });
  return updated;
}

/** Admin-issued reset link (handed over in person; no email service configured). */
export async function createResetLink(admin: UserPrincipal, userId: string) {
  const user = await db.user.findFirst({ where: { id: userId, organizationId: admin.organizationId } });
  if (!user) throw notFound("המשתמש");
  const token = randomToken(24);
  await db.passwordResetToken.create({
    data: { userId, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
  });
  await audit(admin, { action: "user.reset_link_created", entityType: "user", entityId: userId });
  return { url: `${env().APP_URL}/reset/${token}`, expiresInHours: 2 };
}

export async function findResetToken(token: string) {
  const row = await db.passwordResetToken.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { user: true } });
  if (!row || row.usedAt || row.expiresAt < new Date()) return null;
  return row;
}

export async function resetPassword(token: string, password: string) {
  const problem = passwordProblem(password);
  if (problem) throw new AppError("VALIDATION", problem);
  const row = await findResetToken(token);
  if (!row) throw new AppError("NOT_FOUND", "הקישור אינו בתוקף");
  const passwordHash = await hashPassword(password);
  await db.$transaction([
    db.user.update({ where: { id: row.userId }, data: { passwordHash } }),
    db.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    db.session.deleteMany({ where: { userId: row.userId } }),
    db.auditLog.create({ data: { organizationId: row.user.organizationId, userId: row.userId, action: "user.password_reset", entityType: "user", entityId: row.userId } }),
  ]);
}
