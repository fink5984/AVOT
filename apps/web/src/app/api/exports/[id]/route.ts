import { authenticateUser } from "@/server/auth/principal";
import { db } from "@/server/db";
import { notFound } from "@/server/errors";
import { json, route } from "@/server/http";
import { jobDto } from "@/server/services/job-dto";

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "photo.download");
  const { id } = await params;
  const job = await db.job.findFirst({ where: { id, organizationId: user.organizationId, type: "EXPORT_ZIP" } });
  if (!job) throw notFound("עבודת הייצוא");
  return json({ job: jobDto(job) });
});
