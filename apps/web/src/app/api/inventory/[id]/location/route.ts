import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { manualMove, manualMoveSchema, suggestLocations } from "@/server/services/warehouse";

type Ctx = { params: Promise<{ id: string }> };

/** Suggested shelf places (by size class / capacity). */
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "warehouse.view");
  return json({ suggestions: await suggestLocations(user.organizationId, (await params).id) });
});

/** "שנה מיקום": warehouse → column → shelf picked in the UI. Always recorded as a movement. */
export const POST = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "inventory.relocate");
  await manualMove(user, (await params).id, await parseJson(req, manualMoveSchema));
  return json({ ok: true });
});
