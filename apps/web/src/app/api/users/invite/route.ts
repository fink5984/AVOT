import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { inviteSchema, inviteUser } from "@/server/services/users";

export const POST = route(async (req) => {
  const admin = await authenticateUser(req, "user.manage");
  return json(await inviteUser(admin, await parseJson(req, inviteSchema)), { status: 201 });
});
