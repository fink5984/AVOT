import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { listSold } from "@/server/services/sales-views";

export const GET = route(async (req) => {
  const user = await authenticateUser(req, "sales.view");
  const p = new URL(req.url).searchParams;
  const uuid = z.string().uuid().optional().catch(undefined);
  return json(
    await listSold(user, {
      q: p.get("q") ?? undefined,
      houseId: uuid.parse(p.get("houseId") ?? undefined),
      catalogId: uuid.parse(p.get("catalogId") ?? undefined),
      customerId: uuid.parse(p.get("customerId") ?? undefined),
      financial: z.enum(["NONE", "UNPAID", "PARTIAL", "PAID"]).optional().catch(undefined).parse(p.get("financial") ?? undefined),
      stage: p.get("stage") ?? undefined,
    }),
  );
});
