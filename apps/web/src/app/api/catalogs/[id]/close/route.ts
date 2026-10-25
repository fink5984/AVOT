import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { closeCatalog } from "@/server/services/assignments";

/** End of the sale: active lots → unsold, catalog archived. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "commercial.edit");
  return json(await closeCatalog(user, (await params).id));
});
