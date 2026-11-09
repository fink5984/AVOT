import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { compareRuns } from "@/server/services/ai-analysis";

type Ctx = { params: Promise<{ id: string }> };

const query = z.object({ a: z.string().uuid(), b: z.string().uuid() });

/** Two AI runs of the item side by side, with the differences in the input that were sent. Read only. */
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "inventory.view");
  const q = query.parse(Object.fromEntries(new URL(req.url).searchParams));
  return json(await compareRuns(user, (await params).id, q.a, q.b));
});
