import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { applyRun, applyRunSchema } from "@/server/services/ai-analysis";

type Ctx = { params: Promise<{ runId: string }> };

/** Applies a saved AI result (a re-analysis kept for comparison) to the item: all of it, or the chosen fields. */
export const POST = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "ai.apply");
  return json(await applyRun(user, (await params).runId, await parseJson(req, applyRunSchema)));
});
