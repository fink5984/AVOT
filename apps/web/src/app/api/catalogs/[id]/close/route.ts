import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { archiveCatalog } from "@/server/services/sale-finish";

/** Archive the catalog after the sale was finished. Lots, purchases, payments and shipments are not touched. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "sale.finish");
  return json(await archiveCatalog(user, (await params).id));
});
