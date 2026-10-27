import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { addColumn, addColumnSchema } from "@/server/services/warehouse";

export const POST = route(async (req) => {
  const user = await authenticateUser(req, "warehouse.manage");
  return json({ column: await addColumn(user, await parseJson(req, addColumnSchema)) }, { status: 201 });
});
