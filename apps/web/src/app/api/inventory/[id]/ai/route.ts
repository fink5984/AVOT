import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { noteStamp } from "@/server/services/review-notes";
import { getAiLite, getAiState, requestAnalysis, requestSchema } from "@/server/services/ai-analysis";

type Ctx = { params: Promise<{ id: string }> };

/** State of the item's AI analysis and review (the AI button polls it while a run is active). */
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "inventory.view");
  const { id } = await params;
  // ?lite=1: the small state the open pages poll (see getAiLite)
  if (new URL(req.url).searchParams.get("lite") === "1") {
    // ONE poll for everything shared on an open book: the AI state, plus the stamp of its review notes (the notes module is not an AI module: it is joined here, never inside the AI code)
    const [lite, notes] = await Promise.all([getAiLite(user, id), noteStamp(user.organizationId, id)]);
    return json({ ...lite, notes });
  }
  return json(await getAiState(user, id));
});

/** Queues an AI analysis. Re-analysis of an analysed item needs `approval` (a manager's email + password). */
export const POST = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "ai.analyze");
  const { id } = await params;
  const r = await requestAnalysis(user, id, await parseJson(req, requestSchema));
  return json({ ...r, state: await getAiState(user, id) }, { status: r.existing ? 200 : 202 });
});
