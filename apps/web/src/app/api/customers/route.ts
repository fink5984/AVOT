import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { createCustomer, customerInputSchema } from "@/server/services/customers";
import { listCustomers } from "@/server/services/sales-views";

export const GET = route(async (req) => {
  const user = await authenticateUser(req, "customer.view");
  const p = new URL(req.url).searchParams;
  const filter = z.enum(["all", "owing", "waiting", "needsDetails"]).catch("all").parse(p.get("filter") ?? "all");
  return json({ customers: await listCustomers(user, { q: p.get("q") ?? undefined, filter }) });
});

export const POST = route(async (req) => {
  const user = await authenticateUser(req, "customer.edit");
  return json({ customer: await createCustomer(user, await parseJson(req, customerInputSchema)) }, { status: 201 });
});
