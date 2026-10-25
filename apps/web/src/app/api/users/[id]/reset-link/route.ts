import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { createResetLink } from "@/server/services/users";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const admin = await authenticateUser(req, "user.manage");
  const { id } = await params;
  return json(await createResetLink(admin, id));
});
