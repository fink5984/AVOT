import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { customerBooksFor, shippingHint } from "@/server/services/shipments";

/** ?itemId= or ?purchaseId=  → what else the same customer is waiting for;  ?customerId= → all their waiting books */
export const GET = route(async (req) => {
  const user = await authenticateUser(req, "shipment.prepare");
  const p = new URL(req.url).searchParams;
  const customerId = z.string().uuid().optional().catch(undefined).parse(p.get("customerId") ?? undefined);
  if (customerId) return json({ books: await (await customerBooksFor(user))(customerId) });
  return json({ hint: await shippingHint(user, { itemId: p.get("itemId") ?? undefined, purchaseId: p.get("purchaseId") ?? undefined }) });
});
