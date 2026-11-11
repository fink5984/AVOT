import { authenticateUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { forbidden } from "@/server/errors";
import { json, route } from "@/server/http";
import { applyRewriteProposal } from "@/server/services/ai-rewrite";

type Ctx = { params: Promise<{ runId: string }> };

/** Applies the proposal an edit conflict left on a background addition (verified again against the current text). */
export const POST = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "inventory.edit");
  if (!can(user.role, "ai.analyze")) throw forbidden();
  return json(await applyRewriteProposal(user, (await params).runId));
});
