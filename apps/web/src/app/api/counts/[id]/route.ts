import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { countReport } from "@/server/services/counting";

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "warehouse.view");
  return json({ report: await countReport(user.organizationId, (await params).id) });
});
