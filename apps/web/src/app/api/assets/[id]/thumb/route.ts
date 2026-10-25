import { authenticateUser } from "@/server/auth/principal";
import { route } from "@/server/http";
import { serveAsset } from "@/server/services/asset-read";

export const runtime = "nodejs";

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "catalog.view");
  const { id } = await params;
  return serveAsset(user.organizationId, id, "thumb");
});
