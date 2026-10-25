import { authenticateUser } from "@/server/auth/principal";
import { contentDisposition, route } from "@/server/http";
import { getCatalogForUser } from "@/server/services/catalogs";
import { lotsCsv } from "@/server/services/exports";

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "photo.download");
  const { id } = await params;
  await getCatalogForUser(user, id);
  const { filename, body } = await lotsCsv(user.organizationId, id);
  return new Response(body, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": contentDisposition(filename), "cache-control": "no-store" },
  });
});
