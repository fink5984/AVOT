import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { correctPurchase, correctPurchaseSchema } from "@/server/services/sales";

export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "sales.correct");
  const p = await correctPurchase(user, (await params).id, await parseJson(req, correctPurchaseSchema));
  return json({ purchase: { id: p.id, hammerPrice: p.hammerPrice.toFixed(2), customerId: p.customerId } });
});
