import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { INVENTORY_VIEWS, createItem, itemInputSchema, listInventory } from "@/server/services/inventory";

export const GET = route(async (req) => {
  const user = await authenticateUser(req, "inventory.view");
  const p = new URL(req.url).searchParams;
  const view = z.enum(INVENTORY_VIEWS).catch("all").parse(p.get("view") ?? "all");
  return json(
    await listInventory(user, {
      q: p.get("q") ?? undefined,
      view,
      houseId: p.get("houseId") ?? undefined,
      photoStatus: p.get("photoStatus") ?? undefined,
      physicalStatus: p.get("physicalStatus") ?? undefined,
      sort: (p.get("sort") as "updated" | "number" | "title" | null) ?? undefined,
      page: Number(p.get("page") ?? 1) || 1,
      pageSize: Number(p.get("pageSize") ?? 100) || 100,
    }),
  );
});

/** Receive a new physical book into inventory. */
export const POST = route(async (req) => {
  const user = await authenticateUser(req, "inventory.create");
  const item = await createItem(user, await parseJson(req, itemInputSchema));
  return json({ item }, { status: 201 });
});
