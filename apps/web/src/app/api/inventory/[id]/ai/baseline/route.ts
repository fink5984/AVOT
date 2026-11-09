import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { confirmBaselineFromCurrent } from "@/server/ai/baseline";

type Ctx = { params: Promise<{ id: string }> };

/**
 * A manager confirms the item's CURRENT data as its original data (used when the original could not be reconstructed
 * for an item analysed before the baseline existed). Explicit and logged.
 */
export const POST = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "ai.reanalyze.approve");
  const b = await confirmBaselineFromCurrent(user, (await params).id);
  return json({ ok: true, hash: b.hash, source: b.source });
});
