import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { applyLotAiRun, applyLotAiSchema, discardLotAiRun } from "@/server/services/lot-ai";

const schema = z.union([z.object({ action: z.literal("apply") }).merge(applyLotAiSchema), z.object({ action: z.literal("discard") })]);

/** Apply the previewed text to the lot (as a new description version), or discard the proposal. */
export const POST = route<{ params: Promise<{ runId: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "ai.apply");
  const { runId } = await params;
  const input = await parseJson(req, schema);
  if (input.action === "discard") {
    await discardLotAiRun(user, runId);
    return json({ ok: true });
  }
  const { action: _a, ...fields } = input;
  return json(await applyLotAiRun(user, runId, fields));
});
