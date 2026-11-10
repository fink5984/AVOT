import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { getLotForUser } from "@/server/services/lots";
import { lotFulfilment } from "@/server/services/picking";

/** Pick / pack / ship progress of a sold lot: "נאספו 2 מתוך 3 ספרים". */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "inventory.view");
  const lot = await getLotForUser(user, (await params).id);
  return json(await lotFulfilment(lot.id));
});
