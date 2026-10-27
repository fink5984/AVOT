import { authenticate } from "@/server/auth/principal";
import { forbidden } from "@/server/errors";
import { json, parseJson, route } from "@/server/http";
import { printAgentHeartbeat, printHeartbeatSchema } from "@/server/services/printing";

export const POST = route(async (req) => {
  const principal = await authenticate(req, { allowDevice: true });
  if (principal.kind !== "device") throw forbidden();
  return json(await printAgentHeartbeat(principal, await parseJson(req, printHeartbeatSchema)));
});
