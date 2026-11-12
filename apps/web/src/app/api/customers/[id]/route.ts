import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { customerPatchSchema, updateCustomer } from "@/server/services/customers";
import { customerDetail } from "@/server/services/sales-views";

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "customer.view");
  return json(await customerDetail(user, (await params).id));
});

export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "customer.edit");
  return json({ customer: await updateCustomer(user, (await params).id, await parseJson(req, customerPatchSchema)) });
});
