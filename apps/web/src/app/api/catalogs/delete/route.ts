import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { deleteRequestSchema, requestDeleteCatalogs } from "@/server/services/deletion";

/** Permanent deletion of catalogs; their books stay in inventory. */
export const POST = route(async (req) => {
  const user = await authenticateUser(req, "catalog.delete");
  const { ids } = await parseJson(req, deleteRequestSchema);
  return json(await requestDeleteCatalogs(user, ids), { status: 202 });
});
