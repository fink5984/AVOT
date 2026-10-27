import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { deleteRequestSchema, previewDeleteCatalogs } from "@/server/services/deletion";

export const POST = route(async (req) => {
  const user = await authenticateUser(req, "catalog.delete");
  const { ids } = await parseJson(req, deleteRequestSchema);
  return json(await previewDeleteCatalogs(user, ids));
});
