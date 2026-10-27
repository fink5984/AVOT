import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { createWarehouseFromWizard, warehouseWizardSchema } from "@/server/services/warehouse";

/** Name + columns + shelves per column -> the whole warehouse with locations and barcodes. */
export const POST = route(async (req) => {
  const user = await authenticateUser(req, "warehouse.manage");
  return json({ warehouse: await createWarehouseFromWizard(user, await parseJson(req, warehouseWizardSchema)) }, { status: 201 });
});
