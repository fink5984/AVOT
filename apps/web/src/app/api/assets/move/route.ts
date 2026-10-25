import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { moveAssets, moveSchema } from "@/server/services/assets";

export const POST = route(async (req) => {
  const user = await authenticateUser(req, "photo.organize");
  await moveAssets(user, await parseJson(req, moveSchema));
  return json({ ok: true });
});
