import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { finishSale, finishSalePreview, finishSaleSchema } from "@/server/services/sale-finish";

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "sale.finish");
  return json(await finishSalePreview(user, (await params).id));
});

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "sale.finish");
  return json(await finishSale(user, (await params).id, await parseJson(req, finishSaleSchema)));
});
