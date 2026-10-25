import "server-only";
import { asJson } from "../json";
import { z } from "zod";
import { DEFAULT_REQUIREMENTS, PHOTO_CATEGORIES } from "@avot/shared";
import { db } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { UserPrincipal } from "../auth/principal";
import { assertHouse, catalogScope } from "../auth/houses";

const requirementSchema = z.object({ required: z.boolean(), min: z.number().int().min(0).max(500) });
export const requirementsSchema = z.object(
  Object.fromEntries(PHOTO_CATEGORIES.map((c) => [c, requirementSchema])) as Record<
    (typeof PHOTO_CATEGORIES)[number],
    typeof requirementSchema
  >,
);

export const catalogInputSchema = z.object({
  auctionHouseId: z.string().uuid().optional(),
  number: z.string().trim().min(1, "מספר קטלוג נדרש").max(30),
  name: z.string().trim().min(1, "שם הקטלוג נדרש").max(200),
  description: z.string().trim().max(5000).nullish(),
  saleDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(),
  defaultRequirements: requirementsSchema.optional(),
});
export type CatalogInput = z.infer<typeof catalogInputSchema>;

async function houseOf(user: UserPrincipal, houseId: string | undefined) {
  const house = houseId
    ? await db.auctionHouse.findFirst({ where: { id: houseId, organizationId: user.organizationId } })
    : await db.auctionHouse.findFirst({ where: { organizationId: user.organizationId, ...(user.houseIds ? { id: { in: user.houseIds } } : {}) }, orderBy: { sortOrder: "asc" } });
  if (!house) throw notFound("בית המכירות");
  assertHouse(user, house.id);
  return house;
}

export async function getCatalogForUser(user: UserPrincipal, id: string) {
  const catalog = await db.catalog.findFirst({ where: { id, organizationId: user.organizationId }, include: { auctionHouse: true } });
  if (!catalog) throw notFound("הקטלוג");
  assertHouse(user, catalog.auctionHouseId);
  return catalog;
}

/** Catalog numbers are unique within an auction house (אבות 12 and טבין 12 may both exist). */
export async function createCatalog(user: UserPrincipal, input: CatalogInput) {
  const house = await houseOf(user, input.auctionHouseId);
  const exists = await db.catalog.findUnique({ where: { auctionHouseId_number: { auctionHouseId: house.id, number: input.number } } });
  if (exists) throw new AppError("CONFLICT", `קטלוג מספר ${input.number} כבר קיים ב${house.name}`);
  const catalog = await db.catalog.create({
    data: {
      organizationId: user.organizationId,
      auctionHouseId: house.id,
      number: input.number,
      name: input.name,
      description: input.description ?? null,
      saleDate: input.saleDate ? new Date(input.saleDate) : null,
      status: input.status ?? "ACTIVE",
      defaultRequirements: asJson(input.defaultRequirements ?? DEFAULT_REQUIREMENTS),
    },
  });
  await audit(user, { action: "catalog.created", entityType: "catalog", entityId: catalog.id, data: { number: catalog.number, name: catalog.name, house: house.slug } });
  return catalog;
}

export async function updateCatalog(user: UserPrincipal, id: string, input: Partial<CatalogInput>) {
  const catalog = await getCatalogForUser(user, id);
  if (input.number && input.number !== catalog.number) {
    const clash = await db.catalog.findUnique({ where: { auctionHouseId_number: { auctionHouseId: catalog.auctionHouseId, number: input.number } } });
    if (clash) throw new AppError("CONFLICT", `קטלוג מספר ${input.number} כבר קיים`);
  }
  const updated = await db.catalog.update({
    where: { id },
    data: {
      number: input.number,
      name: input.name,
      description: input.description === undefined ? undefined : input.description,
      saleDate: input.saleDate === undefined ? undefined : input.saleDate ? new Date(input.saleDate) : null,
      status: input.status,
      archivedAt: input.status === undefined ? undefined : input.status === "ARCHIVED" ? new Date() : null,
      defaultRequirements: input.defaultRequirements ? asJson(input.defaultRequirements) : undefined,
    },
  });
  await audit(user, { action: "catalog.updated", entityType: "catalog", entityId: id, data: input as object });
  return updated;
}

/**
 * Copies a catalog's settings (house, description, photo requirements) into a
 * new, empty catalog. Lots are not copied: lots are physical books, and a book
 * moves to a new catalog by being assigned (see assignments.ts / inventory).
 */
export async function duplicateCatalog(user: UserPrincipal, id: string, input: { number: string; name: string }) {
  const source = await getCatalogForUser(user, id);
  const clash = await db.catalog.findUnique({ where: { auctionHouseId_number: { auctionHouseId: source.auctionHouseId, number: input.number } } });
  if (clash) throw new AppError("CONFLICT", `קטלוג מספר ${input.number} כבר קיים`);
  const copy = await db.catalog.create({
    data: {
      organizationId: user.organizationId,
      auctionHouseId: source.auctionHouseId,
      number: input.number,
      name: input.name,
      description: source.description,
      status: "DRAFT",
      defaultRequirements: asJson(source.defaultRequirements ?? DEFAULT_REQUIREMENTS),
    },
  });
  await audit(user, { action: "catalog.duplicated", entityType: "catalog", entityId: copy.id, data: { from: id } });
  return copy;
}

/**
 * Hard delete only for catalogs without lots. A catalog with lots (current or
 * historical assignments) is archived instead — the books' history is kept.
 */
export async function deleteCatalog(user: UserPrincipal, id: string) {
  const catalog = await getCatalogForUser(user, id);
  const lots = await db.lot.count({ where: { catalogId: id } });
  if (lots > 0) throw new AppError("CONFLICT", `בקטלוג ${lots} פריטים (כולל שיוכים שהסתיימו). ניתן לארכב אותו, אך לא למחוק.`);
  await db.catalog.delete({ where: { id } });
  await audit(user, { action: "catalog.deleted", entityType: "catalog", entityId: id, data: { number: catalog.number, name: catalog.name } });
}

export async function listCatalogs(user: UserPrincipal, opts: { q?: string; status?: string; sort?: string; houseId?: string } = {}) {
  const where = {
    organizationId: user.organizationId,
    ...catalogScope(user),
    ...(opts.houseId ? { auctionHouseId: opts.houseId } : {}),
    ...(opts.status && opts.status !== "ALL" ? { status: opts.status as "DRAFT" | "ACTIVE" | "ARCHIVED" } : {}),
    ...(opts.q
      ? { OR: [{ name: { contains: opts.q, mode: "insensitive" as const } }, { number: { contains: opts.q } }] }
      : {}),
  };
  const orderBy =
    opts.sort === "name"
      ? { name: "asc" as const }
      : opts.sort === "number"
        ? { number: "asc" as const }
        : { updatedAt: "desc" as const };
  const catalogs = await db.catalog.findMany({ where, orderBy, take: 500, include: { auctionHouse: { select: { id: true, slug: true, name: true, accentColor: true } } } });
  const ids = catalogs.map((c) => c.id);
  const lotStats = await db.lot.groupBy({ by: ["catalogId", "status"], where: { catalogId: { in: ids } }, _count: { _all: true }, _sum: { photoCount: true } });
  return catalogs.map((c) => {
    const stats = lotStats.filter((s) => s.catalogId === c.id);
    return {
      ...c,
      lotCount: stats.reduce((a, s) => a + s._count._all, 0),
      completedCount: stats.find((s) => s.status === "COMPLETED")?._count._all ?? 0,
      photoCount: stats.reduce((a, s) => a + (s._sum.photoCount ?? 0), 0),
    };
  });
}
