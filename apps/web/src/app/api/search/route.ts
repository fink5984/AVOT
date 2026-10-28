import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { globalSearch } from "@/server/services/search";

export const GET = route(async (req) => {
  const user = await authenticateUser(req, "inventory.view");
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 200);
  const r = await globalSearch(user, q);
  return json({
    directLotId: r.directLotId,
    directItemId: r.directItemId,
    directLocationId: r.directLocationId,
    directLocation: r.directLocation,
    items: r.items,
    lots: r.lots.map((l) => ({
      id: l.id,
      lotNumber: l.lotNumber,
      title: l.title,
      subtitle: l.subtitle,
      status: l.status,
      photoCount: l.photoCount,
      assignmentStatus: l.assignmentStatus,
      catalog: { id: l.catalog.id, number: l.catalog.number, name: l.catalog.name, house: l.catalog.auctionHouse.name },
    })),
    catalogs: r.catalogs.map((c) => ({ id: c.id, number: c.number, name: c.name, status: c.status, house: c.auctionHouse.name })),
  });
});
