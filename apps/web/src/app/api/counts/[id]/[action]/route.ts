import { authenticateUser } from "@/server/auth/principal";
import { notFound } from "@/server/errors";
import { json, parseJson, route } from "@/server/http";
import { approveCount, approveSchema, cancelCount, submitCount } from "@/server/services/counting";

/** submit (counter) · approve / cancel (manager). Approval applies only the corrections selected in the body. */
export const POST = route<{ params: Promise<{ id: string; action: string }> }>(async (req, { params }) => {
  const { id, action } = await params;
  if (action === "submit") await submitCount(await authenticateUser(req, "warehouse.operate"), id);
  else if (action === "approve") await approveCount(await authenticateUser(req, "warehouse.manage"), id, await parseJson(req, approveSchema));
  else if (action === "cancel") await cancelCount(await authenticateUser(req, "warehouse.manage"), id);
  else throw notFound("הפעולה");
  return json({ ok: true });
});
