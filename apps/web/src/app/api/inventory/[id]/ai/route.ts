import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { getAiLite, getAiState, requestAnalysis, requestSchema } from "@/server/services/ai-analysis";

type Ctx = { params: Promise<{ id: string }> };

/** State of the item's AI analysis and review (the AI button polls it while a run is active). */
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "inventory.view");
  const { id } = await params;
  // ?lite=1: the small state the open pages poll (see getAiLite)
  if (new URL(req.url).searchParams.get("lite") === "1") return json(await getAiLite(user, id));
  return json(await getAiState(user, id));
});

/** Queues an AI analysis. Re-analysis of an analysed item needs `approval` (a manager's email + password). */
export const POST = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "ai.analyze");
  const { id } = await params;
  const r = await requestAnalysis(user, id, await parseJson(req, requestSchema));
  return json({ ...r, state: await getAiState(user, id) }, { status: r.existing ? 200 : 202 });
});
