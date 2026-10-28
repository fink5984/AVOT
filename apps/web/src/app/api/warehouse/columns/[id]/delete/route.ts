import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { deleteColumn, deleteColumnSchema, deleteEmptyShelves, planColumnDeletion } from "@/server/services/warehouse";

type Ctx = { params: Promise<{ id: string }> };

/**
 * mode "plan": what deleting the column would affect · "column": delete it (books go to `moveToLocationId`) ·
 * "empty-shelves": remove only the shelves that hold no book (`dryRun` lists them).
 */
export const POST = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "warehouse.manage");
  const { id } = await params;
  const body = await parseJson(req, deleteColumnSchema.extend({ mode: z.enum(["plan", "column", "empty-shelves"]), dryRun: z.boolean().optional() }));
  if (body.mode === "plan") return json({ plan: await planColumnDeletion(user, id) });
  if (body.mode === "empty-shelves") return json({ result: await deleteEmptyShelves(user, id, body.dryRun) });
  return json({ result: await deleteColumn(user, id, body) });
});
