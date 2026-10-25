import { z } from "zod";
import { PHOTO_CATEGORIES } from "@avot/shared";
import { authenticateUser } from "@/server/auth/principal";
import { notFound } from "@/server/errors";
import { json, route } from "@/server/http";
import { listAssets, listLotAssets } from "@/server/services/assets";
import { toAssetDto } from "@/server/services/asset-dto";
import { getLotForUser } from "@/server/services/lots";
import { resolveItemTarget } from "@/server/services/inventory";

/**
 * Photos of a book. `id` may be a catalog lot or an inventory item.
 * Default: the book's master order (photography). `?scope=lot`: as that lot presents them.
 */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "inventory.view");
  const { id } = await params;
  const url = new URL(req.url);
  const cat = url.searchParams.get("category");
  const category = cat ? z.enum(PHOTO_CATEGORIES).parse(cat) : undefined;
  const target = await resolveItemTarget(user.organizationId, id);
  if (!target) throw notFound("הספר");
  if (target.lot) {
    const lot = await getLotForUser(user, target.lot.id);
    if (url.searchParams.get("scope") === "lot") return json({ assets: (await listLotAssets(user.organizationId, lot, category)).map(toAssetDto) });
  }
  const assets = await listAssets(user.organizationId, target.itemId, category);
  return json({ assets: assets.map(toAssetDto) });
});
