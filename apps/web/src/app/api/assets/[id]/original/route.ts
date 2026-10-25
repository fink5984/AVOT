import { authenticateUser } from "@/server/auth/principal";
import { route } from "@/server/http";
import { serveAsset } from "@/server/services/asset-read";

export const runtime = "nodejs";

/** Full-resolution original. ?role=RAW for the RAW file of a RAW+JPEG shot; ?download=1 for attachment. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "photo.download");
  const { id } = await params;
  const url = new URL(req.url);
  return serveAsset(user.organizationId, id, "original", {
    role: url.searchParams.get("role") === "RAW" ? "RAW" : "PRIMARY",
    download: url.searchParams.get("download") === "1",
  });
});
