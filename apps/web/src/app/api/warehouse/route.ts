import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { createWarehouse, warehouseSchema, warehouseTree } from "@/server/services/warehouse";

export const GET = route(async (req) => {
  const user = await authenticateUser(req, "warehouse.view");
  return json({ warehouses: await warehouseTree(user.organizationId) });
});

export const POST = route(async (req) => {
  const user = await authenticateUser(req, "warehouse.manage");
  return json({ warehouse: await createWarehouse(user, await parseJson(req, warehouseSchema)) }, { status: 201 });
});
