import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { listScanEvents } from "@/server/services/scanning";

export const GET = route(async (req) => {
  const user = await authenticateUser(req, "warehouse.view");
  const p = new URL(req.url).searchParams;
  return json({ events: await listScanEvents(user.organizationId, { onlyOpen: p.get("open") === "1", result: p.get("result") ?? undefined, take: Number(p.get("take") ?? 200) }) });
});
