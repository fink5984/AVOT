import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { addShelvesToColumn } from "@/server/services/warehouse";

const schema = z.object({ count: z.number().int().min(1).max(99) });

/** Adds N shelves (each with its location and barcode) at the end of a column. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "warehouse.manage");
  await addShelvesToColumn(user, { zoneId: (await params).id, count: (await parseJson(req, schema)).count });
  return json({ ok: true }, { status: 201 });
});
