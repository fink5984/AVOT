import { authenticateUser } from "@/server/auth/principal";
import { notFound } from "@/server/errors";
import { json, route } from "@/server/http";
import { findLocationByCode } from "@/server/services/warehouse";
import { locationLabel } from "@/server/services/location-label";

/** `?code=LOC-W1-C4-04` looks a shelf up by its printed code (a former code with a cell suffix works too). */
export const GET = route(async (req) => {
  const user = await authenticateUser(req, "warehouse.view");
  const code = new URL(req.url).searchParams.get("code") ?? "";
  const loc = await findLocationByCode(user.organizationId, code);
  if (!loc) throw notFound("המיקום");
  return json({ location: { id: loc.id, code: loc.code, label: locationLabel(loc), active: loc.active } });
});
