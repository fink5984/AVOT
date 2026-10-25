import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { createZone, zoneSchema } from "@/server/services/warehouse";

export const POST = route(async (req) => {
  const user = await authenticateUser(req, "warehouse.manage");
  return json({ zone: await createZone(user, await parseJson(req, zoneSchema)) }, { status: 201 });
});
