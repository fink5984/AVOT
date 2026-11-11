import { authenticateUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { forbidden } from "@/server/errors";
import { json, parseJson, route } from "@/server/http";
import { getAiState } from "@/server/services/ai-analysis";
import { requestRewrite, rewriteSchema } from "@/server/services/ai-rewrite";

type Ctx = { params: Promise<{ id: string }> };

/**
 * "הוספת מידע ב-AI": queues a background job on the server (202). The addition is applied and saved by the server when the
 * model answers, even if the user left the page; every user sees the item's AI state. Needs editing the item and using the AI.
 */
export const POST = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "inventory.edit");
  if (!can(user.role, "ai.analyze")) throw forbidden();
  const { id } = await params;
  const r = await requestRewrite(user, id, await parseJson(req, rewriteSchema));
  return json({ ...r, state: await getAiState(user, id) }, { status: r.existing ? 200 : 202 });
});
