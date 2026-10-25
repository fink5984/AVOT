import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { restoreAssets } from "@/server/services/assets";

const schema = z.object({ assetIds: z.array(z.string().uuid()).min(1).max(1000) });

export const POST = route(async (req) => {
  const user = await authenticateUser(req, "photo.delete");
  await restoreAssets(user, (await parseJson(req, schema)).assetIds);
  return json({ ok: true });
});
