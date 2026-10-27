import { authenticate } from "@/server/auth/principal";
import { forbidden } from "@/server/errors";
import { json, route } from "@/server/http";
import { deletedCaptureIds } from "@/server/services/deletion";

/** Capture station → server: which shots were deleted for good, so the station can remove its local copies. */
export const GET = route(async (req) => {
  const principal = await authenticate(req, { allowDevice: true });
  if (principal.kind !== "device") throw forbidden();
  const raw = new URL(req.url).searchParams.get("since");
  const since = raw && !Number.isNaN(Date.parse(raw)) ? new Date(raw) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
  return json(await deletedCaptureIds(principal.organizationId, since));
});
