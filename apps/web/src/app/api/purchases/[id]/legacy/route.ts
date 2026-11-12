import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { attachLegacyCustomer, unmarkLegacySold, unmarkSchema } from "@/server/services/legacy-sales";

/** take the "sold in the old system" mark back (a mistake) - the sale stays as history */
export const DELETE = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "sale.legacy");
  const r = await unmarkLegacySold(user, (await params).id, await parseJson(req, unmarkSchema));
  return json(r);
});

/** attach (or clear) the buyer of a legacy sale, later and optionally */
export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "sale.legacy");
  const body = await parseJson(req, z.object({ customerId: z.string().uuid().nullable() }));
  const p = await attachLegacyCustomer(user, (await params).id, body.customerId);
  return json({ purchase: { id: p.id, customerId: p.customerId } });
});
