import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { deletePrinter, printerPatchSchema, updatePrinter } from "@/server/services/printing";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "print.manage");
  return json({ printer: await updatePrinter(user, (await params).id, await parseJson(req, printerPatchSchema)) });
});

export const DELETE = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "print.manage");
  await deletePrinter(user, (await params).id);
  return json({ ok: true });
});
