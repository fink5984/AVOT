import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { listCounts, startCount, startCountSchema } from "@/server/services/counting";

export const GET = route(async (req) => {
  const user = await authenticateUser(req, "warehouse.view");
  const counts = await listCounts(user.organizationId);
  return json({
    counts: counts.map((c) => ({ id: c.id, status: c.status, zone: c.zone?.name ?? null, startedAt: c.startedAt, entries: c._count.entries, locations: c._count.locations })),
  });
});

export const POST = route(async (req) => {
  const user = await authenticateUser(req, "warehouse.operate");
  return json({ count: await startCount(user, await parseJson(req, startCountSchema)) }, { status: 201 });
});
