import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { consignorPatchSchema, deleteConsignor, getConsignor, updateConsignor } from "@/server/services/consignors";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "consignor.view");
  return json({ consignor: await getConsignor(user, (await params).id) });
});

export const PATCH = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "consignor.manage");
  return json({ consignor: await updateConsignor(user, (await params).id, await parseJson(req, consignorPatchSchema)) });
});

/** Only a consignor without any book; otherwise archive it (PATCH archived: true). */
export const DELETE = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "consignor.manage");
  await deleteConsignor(user, (await params).id);
  return json({ ok: true });
});
