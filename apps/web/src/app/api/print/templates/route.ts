import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { listLabelTemplates } from "@/server/services/label-templates";

/** The label calibration of the organization (resolved profile per label type + the defaults). */
export const GET = route(async (req) => {
  const user = await authenticateUser(req, "label.print");
  return json({ templates: await listLabelTemplates(user.organizationId) });
});
