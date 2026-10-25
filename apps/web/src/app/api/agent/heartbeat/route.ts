import { heartbeatSchema } from "@avot/shared";
import { authenticate } from "@/server/auth/principal";
import { forbidden } from "@/server/errors";
import { json, parseJson, route } from "@/server/http";
import { recordHeartbeat } from "@/server/services/devices";

export const POST = route(async (req) => {
  const principal = await authenticate(req, { allowDevice: true });
  if (principal.kind !== "device") throw forbidden();
  return json(await recordHeartbeat(principal, await parseJson(req, heartbeatSchema)));
});
