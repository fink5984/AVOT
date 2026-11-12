import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { duplicateCandidates, mergeCustomers } from "@/server/services/customers";

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "customer.view");
  return json({ candidates: await duplicateCandidates(user, (await params).id) });
});

/** merge THIS customer into another one (after the person confirmed); history and purchases are kept */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "customer.edit");
  const { intoId } = await parseJson(req, z.object({ intoId: z.string().uuid() }));
  return json(await mergeCustomers(user, (await params).id, intoId));
});
