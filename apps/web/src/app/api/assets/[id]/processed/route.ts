import { authenticateUser } from "@/server/auth/principal";
import { route } from "@/server/http";
import { serveAsset } from "@/server/services/asset-read";

export const runtime = "nodejs";

/** Full-resolution processed image (rotated, background removed, cropped). ?download=1 for attachment. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "photo.download");
  const { id } = await params;
  return serveAsset(user.organizationId, id, "processed", { download: new URL(req.url).searchParams.get("download") === "1" });
});
