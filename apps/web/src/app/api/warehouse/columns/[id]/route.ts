import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { renameColumn, renameSchema } from "@/server/services/warehouse";

export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "warehouse.manage");
  const { name } = await parseJson(req, renameSchema);
  return json({ column: await renameColumn(user, (await params).id, name) });
});
