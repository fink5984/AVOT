import "server-only";
import { cookies } from "next/headers";
import { z } from "zod";
import { db } from "../db";
import { notFound } from "../errors";
import { audit } from "../audit";
import type { UserPrincipal } from "../auth/principal";
import { assertHouse } from "../auth/houses";

/** The house the switcher last selected (UI preference only — never an authorisation input). */
export const HOUSE_COOKIE = "avot_house";

export async function listHouses(user: UserPrincipal) {
  return db.auctionHouse.findMany({
    where: { organizationId: user.organizationId, ...(user.houseIds ? { id: { in: user.houseIds } } : {}) },
    orderBy: { sortOrder: "asc" },
  });
}

export async function getHouseBySlug(user: UserPrincipal, slug: string) {
  const house = await db.auctionHouse.findFirst({ where: { organizationId: user.organizationId, slug } });
  if (!house) throw notFound("בית המכירות");
  assertHouse(user, house.id);
  return house;
}

/** Active house for the switcher: the cookie's choice when the user may see it, else the first visible house. */
export async function activeHouse(user: UserPrincipal) {
  const houses = await listHouses(user);
  const slug = (await cookies()).get(HOUSE_COOKIE)?.value;
  return { houses, active: houses.find((h) => h.slug === slug) ?? houses[0] ?? null };
}

export async function houseSummaries(user: UserPrincipal) {
  const houses = await listHouses(user);
  const [catalogs, lots] = await Promise.all([
    db.catalog.groupBy({ by: ["auctionHouseId", "status"], where: { auctionHouseId: { in: houses.map((h) => h.id) } }, _count: { _all: true } }),
    db.$queryRaw<{ houseId: string; status: string; n: number }[]>`
      SELECT c."auctionHouseId"::text AS "houseId", l."commercialStatus"::text AS status, count(*)::int AS n
      FROM "Lot" l JOIN "Catalog" c ON c.id = l."catalogId"
      WHERE c."organizationId" = ${user.organizationId}::uuid AND l."assignmentStatus" = 'ACTIVE'
      GROUP BY 1, 2`,
  ]);
  return houses.map((h) => ({
    ...h,
    catalogs: catalogs.filter((c) => c.auctionHouseId === h.id).reduce((a, c) => a + c._count._all, 0),
    activeCatalogs: catalogs.find((c) => c.auctionHouseId === h.id && c.status === "ACTIVE")?._count._all ?? 0,
    activeLots: lots.filter((l) => l.houseId === h.id).reduce((a, l) => a + l.n, 0),
  }));
}

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "צבע בפורמט ‎#RRGGBB");
export const housePatchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  nameEn: z.string().trim().max(100).nullish(),
  logoUrl: z.string().trim().url().max(500).nullish(),
  primaryColor: color.optional(),
  accentColor: color.optional(),
  settings: z
    .object({
      lotNumberWidth: z.number().int().min(1).max(6).optional(),
      descriptionFooter: z.string().max(2000).optional(),
      publishCurrency: z.string().max(10).optional(),
    })
    .partial()
    .optional(),
});

export async function updateHouse(user: UserPrincipal, id: string, input: z.infer<typeof housePatchSchema>) {
  const house = await db.auctionHouse.findFirst({ where: { id, organizationId: user.organizationId } });
  if (!house) throw notFound("בית המכירות");
  const updated = await db.auctionHouse.update({
    where: { id },
    data: { ...input, settings: input.settings ? { ...(house.settings as object), ...input.settings } : undefined },
  });
  await audit(user, { action: "house.updated", entityType: "house", entityId: id, data: input as object });
  return updated;
}
