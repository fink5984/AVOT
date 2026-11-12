import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { releasePaidOfOrder } from "@/server/services/sales";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "pick.release");
  return json(await releasePaidOfOrder(user, (await params).id));
});
