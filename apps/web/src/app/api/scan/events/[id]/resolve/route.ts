import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { resolveConflict } from "@/server/services/scanning";

const schema = z.object({ action: z.enum(["apply", "dismiss"]) });

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "warehouse.manage");
  await resolveConflict(user, (await params).id, (await parseJson(req, schema)).action);
  return json({ ok: true });
});
