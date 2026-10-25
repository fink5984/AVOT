import { authenticateUser } from "@/server/auth/principal";
import { db } from "@/server/db";
import { json, parseJson, route } from "@/server/http";
import { exportRequestSchema, requestExport } from "@/server/services/exports";
import { jobDto } from "@/server/services/job-dto";

export const GET = route(async (req) => {
  const user = await authenticateUser(req, "photo.download");
  const jobs = await db.job.findMany({
    where: { organizationId: user.organizationId, type: "EXPORT_ZIP", createdById: user.role === "ADMIN" ? undefined : user.userId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return json({ jobs: jobs.map(jobDto) });
});

/** Photographers/viewers may download whole lots/categories; full-catalog exports need export.create. */
export const POST = route(async (req) => {
  const input = await parseJson(req, exportRequestSchema);
  const user = await authenticateUser(req, input.scope === "catalog" ? "export.create" : "photo.download");
  const job = await requestExport(user, input);
  return json({ job: jobDto(job) }, { status: 202 });
});
