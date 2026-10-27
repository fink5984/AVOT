import { authenticate } from "@/server/auth/principal";
import { forbidden } from "@/server/errors";
import { json, parseJson, route } from "@/server/http";
import { printReportSchema, reportPrintJob } from "@/server/services/printing";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const principal = await authenticate(req, { allowDevice: true });
  if (principal.kind !== "device") throw forbidden();
  return json(await reportPrintJob(principal, (await params).id, await parseJson(req, printReportSchema)));
});
