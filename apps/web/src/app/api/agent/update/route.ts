import { authenticate } from "@/server/auth/principal";
import { forbidden } from "@/server/errors";
import { json, route } from "@/server/http";
import { loadRelease, updateAnswer } from "@/server/services/agent-release";

/** Capture Desktop → server: "is there a newer version than mine?" (device-authenticated). */
export const GET = route(async (req) => {
  const principal = await authenticate(req, { allowDevice: true });
  if (principal.kind !== "device") throw forbidden();
  const current = new URL(req.url).searchParams.get("version") ?? "0.0.0";
  return json(updateAnswer(await loadRelease(), /^\d+\.\d+\.\d+$/.test(current) ? current : "0.0.0"));
});
