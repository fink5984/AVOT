import { z } from "zod";
import { PHOTO_CATEGORIES } from "@avot/shared";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { setCategoryNote } from "@/server/services/lots";
import { setItemCategoryNote } from "@/server/services/inventory";
import { db } from "@/server/db";

const schema = z.object({
  needsReshoot: z.boolean().optional(),
  notRequired: z.boolean().optional(),
  note: z.string().trim().max(1000).nullish(),
});

export const PATCH = route<{ params: Promise<{ id: string; category: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "lot.status");
  const { id, category } = await params;
  const cat = z.enum(PHOTO_CATEGORIES).parse(category);
  const input = await parseJson(req, schema);
  // `id` is a lot (catalog screens) or an inventory item (inventory / capture from inventory)
  const isLot = await db.lot.count({ where: { id, organizationId: user.organizationId } });
  return json({ note: isLot ? await setCategoryNote(user, id, cat, input) : await setItemCategoryNote(user, id, cat, input) });
});
