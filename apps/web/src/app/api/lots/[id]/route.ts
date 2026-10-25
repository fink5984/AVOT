import { authenticateUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { db } from "@/server/db";
import { forbidden } from "@/server/errors";
import { json, parseJson, route } from "@/server/http";
import { deleteLot, getLotForUser, lotPatchSchema, updateLot } from "@/server/services/lots";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The lot as API v1 clients know it. `primaryAssetId` is the effective primary
 * photo (this catalog's own choice, else the book's), `status` the book's
 * photography status; `lotPrimaryAssetId` is only the catalog-specific override.
 */
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "catalog.view");
  const { id } = await params;
  const { catalog: _catalog, ...lot } = await getLotForUser(user, id);
  const item = await db.inventoryItem.findUniqueOrThrow({ where: { id: lot.inventoryItemId }, select: { primaryAssetId: true, photoStatus: true, photoCount: true, inventoryNumber: true } });
  return json({
    lot: {
      ...lot,
      lotPrimaryAssetId: lot.primaryAssetId,
      primaryAssetId: lot.primaryAssetId ?? item.primaryAssetId,
      status: item.photoStatus,
      photoCount: item.photoCount,
      inventoryNumber: item.inventoryNumber,
    },
  });
});

export const PATCH = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req);
  const { id } = await params;
  const input = await parseJson(req, lotPatchSchema);
  const onlyStatus = Object.keys(input).every((k) => k === "status");
  if (!can(user.role, onlyStatus ? "lot.status" : "lot.edit")) throw forbidden();
  return json({ lot: await updateLot(user, id, input) });
});

export const DELETE = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "lot.edit");
  const { id } = await params;
  await deleteLot(user, id);
  return json({ ok: true });
});
