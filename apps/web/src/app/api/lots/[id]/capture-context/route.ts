import { authenticateUser } from "@/server/auth/principal";
import { notFound } from "@/server/errors";
import { json, route } from "@/server/http";
import { loadCaptureContext } from "@/server/services/capture-context";
import { getLotForUser } from "@/server/services/lots";

/** Capture context for a catalog lot or an inventory item (`id` may be either). */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "photo.capture");
  const { id } = await params;
  const ctx = await loadCaptureContext(user.organizationId, id);
  if (!ctx) throw notFound("הפריט");
  if (ctx.target === "lot") await getLotForUser(user, id);
  return json(ctx);
});
