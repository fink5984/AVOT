import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { reorderLots } from "@/server/services/lots";

const schema = z.object({ orderedIds: z.array(z.string().uuid()).min(1).max(5000) });

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "lot.edit");
  const { id } = await params;
  await reorderLots(user, id, (await parseJson(req, schema)).orderedIds);
  return json({ ok: true });
});
