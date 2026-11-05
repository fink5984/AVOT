import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { cancelPrintJob, describePrintJob, getPrintJob } from "@/server/services/printing";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "label.print");
  const j = await getPrintJob(user.organizationId, (await params).id);
  return json({ job: await describePrintJob(user.organizationId, j) });
});

/** DELETE = cancel a job that has not reached the printer yet. */
export const DELETE = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "label.print");
  await cancelPrintJob(user, (await params).id);
  return json({ ok: true });
});
