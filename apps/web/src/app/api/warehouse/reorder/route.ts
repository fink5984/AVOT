import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { reorderSchema, reorderStructure } from "@/server/services/warehouse";

export const POST = route(async (req) => {
  const user = await authenticateUser(req, "warehouse.manage");
  await reorderStructure(user, await parseJson(req, reorderSchema));
  return json({ ok: true });
});
