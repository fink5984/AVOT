import { scanOpSchema } from "@avot/shared";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { processScan } from "@/server/services/scanning";
import { rateLimit } from "@/server/rate-limit";

/** One handheld scan (idempotent on opId). Permissions are checked per mode — never taken from the barcode. */
export const POST = route(async (req) => {
  const user = await authenticateUser(req);
  rateLimit(`scan:${user.userId}`, 600, 60_000);
  return json(await processScan(user, await parseJson(req, scanOpSchema)));
});
