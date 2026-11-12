import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { markLegacySold } from "@/server/services/legacy-sales";

/** "סמן כנמכר במערכת הישנה": one action on the book, no body. A repeated request returns the same sale. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "sale.legacy");
  const r = await markLegacySold(user, (await params).id);
  return json({ purchaseId: r.purchase.id, created: r.created }, { status: r.created ? 201 : 200 });
});
