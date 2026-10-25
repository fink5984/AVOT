import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { assignToCatalog } from "@/server/services/assignments";
import { errorResponse } from "@/server/http";
import { AppError } from "@/server/errors";

const schema = z.object({
  itemIds: z.array(z.string().uuid()).min(1).max(500),
  catalogId: z.string().uuid(),
  replaceActive: z.boolean().optional(),
});

/**
 * Assigns several books to one catalog (next free numbers, in the given
 * order). Each book is its own transaction; the response lists what failed
 * (e.g. already in an active catalog) so nothing is silently skipped.
 */
export const POST = route(async (req) => {
  const user = await authenticateUser(req, "catalog.assign");
  const input = await parseJson(req, schema);
  const done: { itemId: string; lotNumber: number }[] = [];
  const failed: { itemId: string; message: string }[] = [];
  for (const itemId of input.itemIds) {
    try {
      const lot = await assignToCatalog(user, itemId, { catalogId: input.catalogId, replaceActive: input.replaceActive, endOutcome: "WITHDRAWN" });
      done.push({ itemId, lotNumber: lot.lotNumber });
    } catch (err) {
      if (!(err instanceof AppError)) return errorResponse(err);
      failed.push({ itemId, message: err.message });
    }
  }
  return json({ done, failed });
});
