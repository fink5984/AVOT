import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { dismissNeedsUpdate, generateLotDescription, getLotAiState } from "@/server/services/lot-ai";

type Ctx = { params: Promise<{ id: string }> };

/** State of the shared AI description: runs, stale marks, whether the text needs an update. */
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "catalog.view");
  return json(await getLotAiState(user, (await params).id));
});

/** "יצירת תיאור משותף ב-AI": no model or provider in the request - the organization's AI settings decide. */
export const POST = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "ai.analyze");
  const run = await generateLotDescription(user, (await params).id);
  return json({ runId: run.id });
});

/** The person confirms the current text still fits (clears "needs an update"). */
export const PATCH = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "lot.edit");
  await dismissNeedsUpdate(user, (await params).id);
  return json({ ok: true });
});
