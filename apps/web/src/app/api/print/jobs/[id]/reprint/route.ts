import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { reprintJob } from "@/server/services/printing";

const bodySchema = z.object({ confirmed: z.boolean().optional(), confirmCount: z.number().int().optional() });

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "label.print");
  // the body is optional: a small reprint sends none
  const text = await req.text();
  const body = text.trim() ? bodySchema.parse(JSON.parse(text)) : {};
  const job = await reprintJob(user, (await params).id, body);
  return json({ job: { id: job.id, status: job.status } }, { status: 201 });
});
