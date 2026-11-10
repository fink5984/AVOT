import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { mergeLots, mergeSchema } from "@/server/services/lot-members";

const body = mergeSchema.omit({ catalogId: true });

/** "איחוד ללוט": combines the selected single-book lots of this catalog into one lot (all rules are checked on the server). */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "catalog.assign");
  const { id } = await params;
  const input = await parseJson(req, body as z.ZodType<z.input<typeof body>>);
  return json(await mergeLots(user, { ...input, catalogId: id }));
});
