import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { dissolveLot } from "@/server/services/lot-members";

/** "פירוק הלוט": every book returns to a separate lot of the same catalog. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "catalog.assign");
  return json(await dissolveLot(user, (await params).id));
});
