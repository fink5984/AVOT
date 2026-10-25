import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { duplicateLot } from "@/server/services/lots";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "lot.edit");
  const { id } = await params;
  return json({ lot: await duplicateLot(user, id) }, { status: 201 });
});
