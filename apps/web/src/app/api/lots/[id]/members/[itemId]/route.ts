import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { removeBookFromLot } from "@/server/services/lot-members";

/** Removes one book from a combined lot: it returns to a lot of its own in the same catalog. */
export const DELETE = route<{ params: Promise<{ id: string; itemId: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "catalog.assign");
  const { id, itemId } = await params;
  return json(await removeBookFromLot(user, id, itemId));
});
