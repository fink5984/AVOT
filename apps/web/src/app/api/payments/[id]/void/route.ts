import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { voidPayment } from "@/server/services/sales";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "payment.manage");
  const { reason } = await parseJson(req, z.object({ reason: z.string().trim().min(2).max(300) }));
  return json(await voidPayment(user, (await params).id, reason));
});
