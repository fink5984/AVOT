import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { housePatchSchema, updateHouse } from "@/server/services/houses";

export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "house.manage");
  return json({ house: await updateHouse(user, (await params).id, await parseJson(req, housePatchSchema)) });
});
