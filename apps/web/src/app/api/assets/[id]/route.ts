import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { assetPatchSchema, updateAsset } from "@/server/services/assets";
import { toAssetDto } from "@/server/services/asset-dto";

export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "photo.organize");
  const { id } = await params;
  const asset = await updateAsset(user, id, await parseJson(req, assetPatchSchema));
  return json({ asset: toAssetDto(asset) });
});
