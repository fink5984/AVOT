import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { consignorInputSchema, createConsignor, listConsignors } from "@/server/services/consignors";

export const GET = route(async (req) => {
  const user = await authenticateUser(req, "consignor.view");
  const p = new URL(req.url).searchParams;
  return json(await listConsignors(user, { q: p.get("q") ?? undefined, includeArchived: p.get("archived") === "1", limit: Number(p.get("limit") ?? 200) || 200 }));
});

export const POST = route(async (req) => {
  const user = await authenticateUser(req, "consignor.create");
  return json({ consignor: await createConsignor(user, await parseJson(req, consignorInputSchema)) }, { status: 201 });
});
