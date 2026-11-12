import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { AppError } from "@/server/errors";
import { json, route } from "@/server/http";
import { addToShipment, cancelShipment, deliverShipment, packShipment, removeFromShipment, returnBook, returnSchema, shipShipment, shipSchema } from "@/server/services/shipments";

type Ctx = { params: Promise<{ id: string; action: string }> };

/** pack | ship | deliver | cancel | add | remove | return */
export const POST = route<Ctx>(async (req, { params }) => {
  const { id, action } = await params;
  const text = await req.text();
  const body = text.trim() ? JSON.parse(text) : {};
  if (action === "ship" || action === "deliver" || action === "cancel") {
    const user = await authenticateUser(req, "shipment.status");
    if (action === "ship") {
      const s = await shipShipment(user, id, shipSchema.parse(body));
      return json({ status: s.status });
    }
    if (action === "deliver") return json({ status: (await deliverShipment(user, id)).status });
    const { reason } = z.object({ reason: z.string() }).parse(body);
    return json({ status: (await cancelShipment(user, id, reason)).status });
  }
  const user = await authenticateUser(req, "shipment.prepare");
  if (action === "pack") return json(await packShipment(user, id));
  if (action === "add") return json(await addToShipment(user, id, z.object({ purchaseIds: z.array(z.string().uuid()).min(1) }).parse(body).purchaseIds));
  if (action === "remove") {
    const b = z.object({ purchaseId: z.string().uuid(), reason: z.string().max(200).optional() }).parse(body);
    return json(await removeFromShipment(user, id, b.purchaseId, b.reason));
  }
  if (action === "return") {
    const statusUser = await authenticateUser(req, "shipment.status");
    const b = z.object({ itemId: z.string().uuid() }).and(returnSchema).parse(body);
    return json(await returnBook(statusUser, id, b.itemId, b));
  }
  throw new AppError("NOT_FOUND", "פעולה לא מוכרת");
});
