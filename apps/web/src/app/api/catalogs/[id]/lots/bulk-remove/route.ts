import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { removeLotsFromCatalog } from "@/server/services/deletion";

const schema = z.object({ lotIds: z.array(z.string().uuid()).min(1).max(1000) });

/** Removes books from this catalog only — the books and their photos stay in inventory. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "lot.edit");
  return json(await removeLotsFromCatalog(user, (await params).id, (await parseJson(req, schema)).lotIds));
});
