import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { locationPatchSchema, updateLocation } from "@/server/services/warehouse";

export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "warehouse.manage");
  return json({ location: await updateLocation(user, (await params).id, await parseJson(req, locationPatchSchema)) });
});
