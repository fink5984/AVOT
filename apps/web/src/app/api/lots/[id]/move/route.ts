import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { moveLotToCatalog } from "@/server/services/lots";

const schema = z.object({ catalogId: z.string().uuid(), lotNumber: z.number().int().min(1).optional() });

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "lot.edit");
  const { id } = await params;
  const { catalogId, lotNumber } = await parseJson(req, schema);
  return json({ lot: await moveLotToCatalog(user, id, catalogId, lotNumber) });
});
