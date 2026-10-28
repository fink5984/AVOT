import { z } from "zod";
import { authenticate } from "@/server/auth/principal";
import { forbidden } from "@/server/errors";
import { json, parseJson, route } from "@/server/http";
import { agentTestPrint } from "@/server/services/printing";

export const POST = route(async (req) => {
  const principal = await authenticate(req, { allowDevice: true });
  if (principal.kind !== "device") throw forbidden();
  const { printerId } = await parseJson(req, z.object({ printerId: z.string().uuid() }));
  return json(await agentTestPrint(principal, printerId), { status: 201 });
});
