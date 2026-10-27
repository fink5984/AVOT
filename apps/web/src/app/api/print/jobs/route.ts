import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { createPrintJobs, listPrintJobs, printRequestSchema } from "@/server/services/printing";

export const GET = route(async (req) => {
  const user = await authenticateUser(req, "label.print");
  const p = new URL(req.url).searchParams;
  return json({ jobs: await listPrintJobs(user.organizationId, { limit: Number(p.get("limit") ?? 50) || 50, status: p.get("status") ?? undefined }) });
});

/** One click = one request. `idemKey` makes a double click / retried request create the batch once. */
export const POST = route(async (req) => {
  const user = await authenticateUser(req, "label.print");
  const jobs = await createPrintJobs(user, await parseJson(req, printRequestSchema));
  return json({ jobs: jobs.map((j) => ({ id: j.id, status: j.status, labelCount: j.labelCount })) }, { status: 201 });
});
