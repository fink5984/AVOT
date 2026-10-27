import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { deleteRequestSchema, requestDeleteItems } from "@/server/services/deletion";

/** Permanent deletion of books and all their stored files (a durable job; poll /api/deletions/<jobId>). */
export const POST = route(async (req) => {
  const user = await authenticateUser(req, "inventory.delete");
  const { ids } = await parseJson(req, deleteRequestSchema);
  return json(await requestDeleteItems(user, ids), { status: 202 });
});
