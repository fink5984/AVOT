import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { reprocessAsset, reprocessSchema } from "@/server/services/book-processing";
import { toAssetDto } from "@/server/services/asset-dto";

export const runtime = "nodejs";

/**
 * Manual correction of a photo: new settings (rotation, sensitivity, margin, background),
 * a manual crop, brush strokes that erase / restore parts of the book, or `restore: true`
 * to go back to the untouched original. The original file is never modified.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "photo.organize");
  const { id } = await params;
  const asset = await reprocessAsset(user, id, await parseJson(req, reprocessSchema));
  return json({ asset: toAssetDto(asset) });
});
