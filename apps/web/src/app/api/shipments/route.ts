import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { createShipment, createShipmentSchema, shippingOverview } from "@/server/services/shipments";

export const GET = route(async (req) => {
  const user = await authenticateUser(req, "shipment.prepare");
  const p = new URL(req.url).searchParams;
  const uuid = z.string().uuid().optional().catch(undefined);
  return json(
    await shippingOverview(user, {
      q: p.get("q") ?? undefined,
      houseId: uuid.parse(p.get("houseId") ?? undefined),
      catalogId: uuid.parse(p.get("catalogId") ?? undefined),
      financial: p.get("financial") ?? undefined,
      stage: p.get("stage") ?? undefined,
      onlyPartial: p.get("partial") === "1",
      onlyReady: p.get("ready") === "1",
    }),
  );
});

export const POST = route(async (req) => {
  const user = await authenticateUser(req, "shipment.prepare");
  const s = await createShipment(user, await parseJson(req, createShipmentSchema));
  return json({ shipment: { id: s.id, number: s.number, status: s.status } }, { status: 201 });
});
