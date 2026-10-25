import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { createShelf, shelfSchema } from "@/server/services/warehouse";

export const POST = route(async (req) => {
  const user = await authenticateUser(req, "warehouse.manage");
  return json({ shelf: await createShelf(user, await parseJson(req, shelfSchema)) }, { status: 201 });
});
