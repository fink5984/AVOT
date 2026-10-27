import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { reprintJob } from "@/server/services/printing";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "label.print");
  const job = await reprintJob(user, (await params).id);
  return json({ job: { id: job.id, status: job.status } }, { status: 201 });
});
