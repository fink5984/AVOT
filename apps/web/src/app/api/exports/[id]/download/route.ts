import { authenticateUser } from "@/server/auth/principal";
import { db } from "@/server/db";
import { notFound } from "@/server/errors";
import { route } from "@/server/http";
import { storage } from "@/server/storage";

/** Redirects to a short-lived signed link for a finished export. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "photo.download");
  const { id } = await params;
  const job = await db.job.findFirst({ where: { id, organizationId: user.organizationId, type: "EXPORT_ZIP", status: "SUCCEEDED" } });
  if (!job?.resultKey || (job.expiresAt && job.expiresAt < new Date())) throw notFound("קובץ הייצוא");
  const url = await storage().readUrl(job.resultKey, {
    filename: job.resultName ?? "export.zip",
    contentType: "application/zip",
    expiresInSeconds: 600,
  });
  return new Response(null, { status: 302, headers: { location: url, "cache-control": "no-store" } });
});
