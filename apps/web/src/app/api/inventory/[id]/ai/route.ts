import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { getAiState, requestAnalysis, requestSchema } from "@/server/services/ai-analysis";

type Ctx = { params: Promise<{ id: string }> };

/** State of the item's AI analysis and review (the AI button polls it while a run is active). */
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "inventory.view");
  return json(await getAiState(user, (await params).id));
});

/** Queues an AI analysis. Re-analysis of an analysed item needs `approval` (a manager's email + password). */
export const POST = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "ai.analyze");
  const { id } = await params;
  const r = await requestAnalysis(user, id, await parseJson(req, requestSchema));
  return json({ ...r, state: await getAiState(user, id) }, { status: r.existing ? 200 : 202 });
});
