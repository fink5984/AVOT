import { authenticate } from "@/server/auth/principal";
import { forbidden } from "@/server/errors";
import { json, parseJson, route } from "@/server/http";
import { agentPrinterSchema, upsertAgentPrinter } from "@/server/services/printing";

/** Station → server: "this is the label printer I drive" (chosen from the Windows printers). */
export const POST = route(async (req) => {
  const principal = await authenticate(req, { allowDevice: true });
  if (principal.kind !== "device") throw forbidden();
  return json({ printer: await upsertAgentPrinter(principal, await parseJson(req, agentPrinterSchema)) }, { status: 201 });
});
