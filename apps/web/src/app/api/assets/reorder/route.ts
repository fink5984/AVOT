import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { reorderAssets, reorderSchema } from "@/server/services/assets";
import { getLotForUser } from "@/server/services/lots";

export const POST = route(async (req) => {
  const user = await authenticateUser(req, "photo.organize");
  const input = await parseJson(req, reorderSchema.refine((v) => v.orderedIds.length > 0 && (v.lotId || v.inventoryItemId), "חסרים נתונים"));
  if (input.scope === "lot" && input.lotId) await getLotForUser(user, input.lotId);
  await reorderAssets(user, input);
  return json({ ok: true });
});
