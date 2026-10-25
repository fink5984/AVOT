import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { updateUser, userUpdateSchema } from "@/server/services/users";

export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const admin = await authenticateUser(req, "user.manage");
  const { id } = await params;
  const user = await updateUser(admin, id, await parseJson(req, userUpdateSchema));
  return json({ user: { id: user.id, name: user.name, role: user.role, status: user.status } });
});
