import { authenticate } from "@/server/auth/principal";
import { forbidden } from "@/server/errors";
import { json, route } from "@/server/http";
import { claimNextPrintJob } from "@/server/services/printing";

/** Print agent → server: "give me the next label job" (long-poll friendly: returns { job: null } when idle). */
export const POST = route(async (req) => {
  const principal = await authenticate(req, { allowDevice: true });
  if (principal.kind !== "device") throw forbidden();
  return json({ job: await claimNextPrintJob(principal) });
});
