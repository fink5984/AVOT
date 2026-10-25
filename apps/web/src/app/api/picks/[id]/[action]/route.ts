import { authenticateUser } from "@/server/auth/principal";
import { notFound } from "@/server/errors";
import { json, route } from "@/server/http";
import { cancelPickTask, markPacked, markShipped } from "@/server/services/picking";

/** packed / shipped (warehouse) · cancel (managers). */
export const POST = route<{ params: Promise<{ id: string; action: string }> }>(async (req, { params }) => {
  const { id, action } = await params;
  if (action === "packed") await markPacked(await authenticateUser(req, "pick.fulfil"), id);
  else if (action === "shipped") await markShipped(await authenticateUser(req, "pick.fulfil"), id);
  else if (action === "cancel") await cancelPickTask(await authenticateUser(req, "pick.manage"), id);
  else throw notFound("הפעולה");
  return json({ ok: true });
});
