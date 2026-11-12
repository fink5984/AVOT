import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { lotPriceHistory, priceInputSchema, setStartingPrice } from "@/server/services/lot-pricing";

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "catalog.view");
  const { id } = await params;
  return json({ history: await lotPriceHistory(user, id) });
});

/** Quick edit from the catalog table / lot page. Body: { price: "150" | null, expectedVersion? } */
export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "lot.price.edit");
  const { id } = await params;
  return json(await setStartingPrice(user, id, await parseJson(req, priceInputSchema)));
});
