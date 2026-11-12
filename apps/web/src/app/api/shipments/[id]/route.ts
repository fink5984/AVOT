import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { getShipment } from "@/server/services/shipments";

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "shipment.prepare");
  return json({ shipment: await getShipment(user, (await params).id) });
});
