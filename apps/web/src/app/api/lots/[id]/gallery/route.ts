import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { listCombinedLotAssets, lotGalleryOrderSchema, reorderLotGallery } from "@/server/services/assets";
import { toAssetDto } from "@/server/services/asset-dto";
import { getLotForUser } from "@/server/services/lots";

type Ctx = { params: Promise<{ id: string }> };

/** The shared gallery of a combined lot: every book's photos in the lot's order (hidden ones flagged). */
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "catalog.view");
  const lot = await getLotForUser(user, (await params).id);
  const itemId = new URL(req.url).searchParams.get("itemId") ?? undefined;
  const rows = await listCombinedLotAssets(user.organizationId, lot, { itemId });
  return json({ assets: rows.map((a) => ({ ...toAssetDto(a), hidden: a.hidden, book: a.book })) });
});

/** Saves the order of the shared gallery (the visible photos). */
export const PUT = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "lot.edit");
  const { id } = await params;
  await getLotForUser(user, id);
  await reorderLotGallery(user, id, (await parseJson(req, lotGalleryOrderSchema)).orderedAssetIds);
  return json({ ok: true });
});
