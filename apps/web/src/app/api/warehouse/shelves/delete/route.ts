import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { deleteShelves, deleteShelvesSchema, planShelfDeletion } from "@/server/services/warehouse";

/** `dryRun: true` answers "what would happen": books on the shelves, which are removed for real and which only leave the structure. */
export const POST = route(async (req) => {
  const user = await authenticateUser(req, "warehouse.manage");
  const body = await parseJson(req, deleteShelvesSchema.extend({ dryRun: z.boolean().optional() }));
  if (body.dryRun) return json({ plan: await planShelfDeletion(user, body.shelfIds) });
  return json({ result: await deleteShelves(user, body) });
});
