import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { createPickTask } from "@/server/services/picking";

const schema = z.object({ reason: z.string().trim().min(1).max(300), note: z.string().trim().max(1000).nullish() });

/** Manual pick request (sales create one automatically). */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "pick.manage");
  const { reason, note } = await parseJson(req, schema);
  return json({ task: await createPickTask(user, (await params).id, reason, note) }, { status: 201 });
});
