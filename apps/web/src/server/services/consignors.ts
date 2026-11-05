import "server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db, type Tx } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { UserPrincipal } from "../auth/principal";

/*
 * A consignor (מפקיד) deposits books for sale. It belongs to the organization's central inventory — never to a
 * catalog or auction house — so the link to a book survives every move between catalogs and houses. The consignor
 * rule for NEW books lives in `requireConsignor` (called by createItemTx, the only place a book is inserted).
 */

const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

export const consignorInputSchema = z.object({
  name: z.string().trim().min(1, "שם המפקיד נדרש").max(200),
  /** free text so international numbers work: digits, +, spaces, dashes, brackets */
  phone: z
    .string()
    .trim()
    .max(40)
    .regex(/^[0-9+\-()\s./*#]*$/, "טלפון לא תקין")
    .nullish()
    .transform((v) => (v ? v : null)),
  email: z
    .string()
    .trim()
    .max(200)
    .email("כתובת דוא״ל לא תקינה")
    .nullish()
    .or(z.literal(""))
    .transform((v) => (v ? v : null)),
  notes: optionalText(5000),
  /** client key: a double click / retried request returns the consignor it already created */
  opId: z.string().uuid().optional(),
});
export type ConsignorInput = z.input<typeof consignorInputSchema>;
export const consignorPatchSchema = consignorInputSchema.omit({ opId: true }).partial().extend({ archived: z.boolean().optional() });

export interface ConsignorDto {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  archived: boolean;
  bookCount: number;
  createdAt: string;
  updatedAt: string;
}

type ConsignorRow = { id: string; name: string; phone: string | null; email: string | null; notes: string | null; archivedAt: Date | null; createdAt: Date; updatedAt: Date };

const toDto = (c: ConsignorRow, bookCount: number): ConsignorDto => ({
  id: c.id,
  name: c.name,
  phone: c.phone,
  email: c.email,
  notes: c.notes,
  archived: !!c.archivedAt,
  bookCount,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

/** Books that count for a consignor: everything not waiting for its permanent deletion. */
const liveBooks = { deletionRequestedAt: null } as const;

export async function bookCounts(orgId: string, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await db.inventoryItem.groupBy({ by: ["consignorId"], where: { organizationId: orgId, consignorId: { in: ids }, ...liveBooks }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.consignorId!, r._count._all]));
}

/** Consignors whose phone contains these digits, ignoring dashes and spaces ("0501234567" finds "050-123-4567"). */
async function idsByPhoneDigits(orgId: string, digits: string): Promise<string[]> {
  if (digits.length < 3) return [];
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Consignor" WHERE "organizationId" = ${orgId}::uuid AND phone IS NOT NULL
      AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE ${"%" + digits + "%"}`;
  return rows.map((r) => r.id);
}

export function consignorWhere(orgId: string, o: { q?: string; includeArchived?: boolean }, phoneIds: string[] = []): Prisma.ConsignorWhereInput {
  const and: Prisma.ConsignorWhereInput[] = [{ organizationId: orgId }];
  if (!o.includeArchived) and.push({ archivedAt: null });
  const q = o.q?.trim();
  if (q) {
    and.push({
      OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }, ...(phoneIds.length ? [{ id: { in: phoneIds } }] : [])],
    });
  }
  return { AND: and };
}

export async function listConsignors(user: UserPrincipal, o: { q?: string; includeArchived?: boolean; limit?: number } = {}) {
  const where = consignorWhere(user.organizationId, o, o.q ? await idsByPhoneDigits(user.organizationId, o.q.replace(/\D/g, "")) : []);
  const take = Math.min(Math.max(o.limit ?? 200, 1), 500);
  const [total, rows] = await Promise.all([db.consignor.count({ where }), db.consignor.findMany({ where, orderBy: { name: "asc" }, take })]);
  const counts = await bookCounts(user.organizationId, rows.map((r) => r.id));
  return { total, consignors: rows.map((r) => toDto(r, counts.get(r.id) ?? 0)) };
}

export async function getConsignor(user: UserPrincipal, id: string): Promise<ConsignorDto> {
  const c = await db.consignor.findFirst({ where: { id, organizationId: user.organizationId } });
  if (!c) throw notFound("המפקיד");
  return toDto(c, (await bookCounts(user.organizationId, [id])).get(id) ?? 0);
}

export async function createConsignor(user: UserPrincipal, input: ConsignorInput) {
  const data = consignorInputSchema.parse(input);
  const created = await db.consignor.create({
    data: { organizationId: user.organizationId, name: data.name, phone: data.phone ?? null, email: data.email ?? null, notes: data.notes ?? null, createdById: user.userId },
  });
  await audit(user, { action: "consignor.created", entityType: "consignor", entityId: created.id, data: { name: created.name } });
  return toDto(created, 0);
}

export async function updateConsignor(user: UserPrincipal, id: string, input: z.infer<typeof consignorPatchSchema>) {
  const current = await db.consignor.findFirst({ where: { id, organizationId: user.organizationId } });
  if (!current) throw notFound("המפקיד");
  const { archived, ...fields } = input;
  const updated = await db.consignor.update({
    where: { id },
    data: { ...fields, ...(archived === undefined ? {} : { archivedAt: archived ? (current.archivedAt ?? new Date()) : null }) },
  });
  await audit(user, {
    action: archived === undefined ? "consignor.updated" : archived ? "consignor.archived" : "consignor.restored",
    entityType: "consignor",
    entityId: id,
    data: input as object,
  });
  return toDto(updated, (await bookCounts(user.organizationId, [id])).get(id) ?? 0);
}

/**
 * Only a consignor that never received a book can be deleted. One with books (even a hidden "waiting for
 * deletion" one) is archived instead, so no book is ever left without its owner.
 */
export async function deleteConsignor(user: UserPrincipal, id: string) {
  const c = await db.consignor.findFirst({ where: { id, organizationId: user.organizationId } });
  if (!c) throw notFound("המפקיד");
  const books = await db.inventoryItem.count({ where: { organizationId: user.organizationId, consignorId: id } });
  if (books > 0) throw new AppError("CONFLICT", `למפקיד ${books} ספרים משויכים — אי אפשר למחוק אותו. אפשר לארכב אותו (הספרים נשארים משויכים אליו).`);
  await db.consignor.delete({ where: { id } });
  await audit(user, { action: "consignor.deleted", entityType: "consignor", entityId: id, data: { name: c.name } });
}

/* ───────────────────────── the rule for new books ───────────────────────── */

const checked = new WeakMap<object, Set<string>>();

/**
 * Server-side enforcement of "no new book without a consignor": the id must exist, belong to the caller's
 * organization and not be archived. Every path that inserts an InventoryItem goes through createItemTx, which calls this.
 */
export async function requireConsignor(tx: Tx, orgId: string, consignorId: string | null | undefined): Promise<string> {
  if (!consignorId) throw new AppError("VALIDATION", "יש לבחור מפקיד לספר");
  // inside a transaction a verified id is remembered (a 2000-row import checks each consignor once); the shared client never caches
  const memo = (tx as unknown) === db ? new Set<string>() : (checked.get(tx) ?? new Set<string>());
  if (memo.has(consignorId)) return consignorId;
  const c = await tx.consignor.findFirst({ where: { id: consignorId, organizationId: orgId }, select: { archivedAt: true, name: true } });
  if (!c) throw new AppError("VALIDATION", "המפקיד שנבחר לא נמצא");
  if (c.archivedAt) throw new AppError("VALIDATION", `המפקיד ${c.name} בארכיון — בחרו מפקיד פעיל`);
  memo.add(consignorId);
  checked.set(tx, memo);
  return consignorId;
}
