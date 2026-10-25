import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { listPickTasks } from "@/server/services/picking";

/** Open pick tasks in walking order (zone / shelf / cell). */
export const GET = route(async (req) => {
  const user = await authenticateUser(req, "warehouse.view");
  const p = new URL(req.url).searchParams;
  const status = (p.get("status") ?? "open") as "open" | "all";
  return json({ tasks: await listPickTasks(user.organizationId, { status, zoneId: p.get("zoneId") ?? undefined }) });
});
