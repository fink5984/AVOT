import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { bulkCheckout, bulkCheckoutSchema } from "@/server/services/checkout";

/** Desktop twin of the phone scanner's "הוצאה זמנית / הוצאה סופית" — same service, same rules. */
export const POST = route(async (req) => {
  const body = await parseJson(req, bulkCheckoutSchema);
  // temporary removal is a relocation; final removal ships a sold book (warehouse fulfilment)
  const user = await authenticateUser(req, body.kind === "TEMP" ? "inventory.relocate" : "pick.fulfil");
  return json(await bulkCheckout(user, body));
});
