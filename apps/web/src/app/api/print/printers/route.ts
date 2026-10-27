import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { createPrinter, listPrinters, printerSchema } from "@/server/services/printing";

export const GET = route(async (req) => {
  const user = await authenticateUser(req, "label.print");
  return json(await listPrinters(user.organizationId));
});

export const POST = route(async (req) => {
  const user = await authenticateUser(req, "print.manage");
  return json({ printer: await createPrinter(user, await parseJson(req, printerSchema)) }, { status: 201 });
});
