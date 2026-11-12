import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { cancelPurchase, cancelPurchaseSchema } from "@/server/services/sales";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "sale.cancel");
  return json(await cancelPurchase(user, (await params).id, await parseJson(req, cancelPurchaseSchema)));
});
