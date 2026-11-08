import { authenticateUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { forbidden } from "@/server/errors";
import { json, parseJson, route } from "@/server/http";
import { rewriteCatalog, rewriteSchema } from "@/server/services/ai-analysis";

type Ctx = { params: Promise<{ id: string }> };

/**
 * "שכתוב ב-AI": a new headline + description from the checked details, the draft and the reviewer's additions.
 * Returns a proposal; nothing is written to the item. Needs both editing the item and using the AI.
 */
export const POST = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "inventory.edit");
  if (!can(user.role, "ai.analyze")) throw forbidden();
  return json(await rewriteCatalog(user, (await params).id, await parseJson(req, rewriteSchema)));
});
