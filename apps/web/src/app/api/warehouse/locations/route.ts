import { authenticateUser } from "@/server/auth/principal";
import { notFound } from "@/server/errors";
import { json, parseJson, route } from "@/server/http";
import { createLocations, findLocationByCode, locationsSchema } from "@/server/services/warehouse";
import { locationLabel } from "@/server/services/location-label";

/** `?code=LOC-A-03-02` looks a location up by its printed code. */
export const GET = route(async (req) => {
  const user = await authenticateUser(req, "warehouse.view");
  const code = new URL(req.url).searchParams.get("code") ?? "";
  const loc = await findLocationByCode(user.organizationId, code);
  if (!loc) throw notFound("המיקום");
  return json({ location: { id: loc.id, code: loc.code, label: locationLabel(loc), active: loc.active } });
});

export const POST = route(async (req) => {
  const user = await authenticateUser(req, "warehouse.manage");
  return json({ locations: await createLocations(user, await parseJson(req, locationsSchema)) }, { status: 201 });
});
