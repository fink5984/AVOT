import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { listHouses } from "@/server/services/houses";

/** Auction houses the user may see (all of them for admins). */
export const GET = route(async (req) => {
  const user = await authenticateUser(req, "catalog.view");
  const houses = await listHouses(user);
  return json({ houses: houses.map((h) => ({ id: h.id, slug: h.slug, name: h.name, nameEn: h.nameEn, logoUrl: h.logoUrl, primaryColor: h.primaryColor, accentColor: h.accentColor })) });
});
