import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { deletionStatus } from "@/server/services/deletion";

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "inventory.view");
  return json(await deletionStatus(user, (await params).id));
});
