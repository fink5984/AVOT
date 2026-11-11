import { authenticateUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { forbidden } from "@/server/errors";
import { json, route } from "@/server/http";
import { undoRewrite } from "@/server/services/ai-rewrite";

type Ctx = { params: Promise<{ runId: string }> };

/** "ביטול ההוספה": puts back the values (and their formatting) a background addition replaced, never over a newer edit. */
export const POST = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "inventory.edit");
  if (!can(user.role, "ai.analyze")) throw forbidden();
  return json(await undoRewrite(user, (await params).runId));
});
