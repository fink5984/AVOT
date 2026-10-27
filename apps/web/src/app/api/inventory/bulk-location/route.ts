import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { bulkManualMove, bulkMoveSchema } from "@/server/services/warehouse";

/** Place several selected books on one shelf (movement history for each). */
export const POST = route(async (req) => {
  const user = await authenticateUser(req, "inventory.relocate");
  return json(await bulkManualMove(user, await parseJson(req, bulkMoveSchema)));
});
