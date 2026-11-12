import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { recordSale, recordSaleSchema } from "@/server/services/sales";

/** a sale recorded by hand (also a deal after the auction, and a buyer for a lot that was marked sold without one) */
export const POST = route(async (req) => {
  const user = await authenticateUser(req, "sales.correct");
  const p = await recordSale(user, await parseJson(req, recordSaleSchema));
  return json({ purchase: { id: p.id, orderId: p.orderId, afterAuction: p.afterAuction } }, { status: 201 });
});
