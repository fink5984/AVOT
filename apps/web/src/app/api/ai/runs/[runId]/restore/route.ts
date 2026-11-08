import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { restoreRun } from "@/server/services/ai-analysis";

type Ctx = { params: Promise<{ runId: string }> };

/** Restores the item values an AI run replaced (its snapshot). */
export const POST = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "ai.restore");
  return json(await restoreRun(user, (await params).runId));
});
