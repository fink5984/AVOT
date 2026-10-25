import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { catalogInputSchema, createCatalog, listCatalogs } from "@/server/services/catalogs";

export const GET = route(async (req) => {
  const user = await authenticateUser(req, "catalog.view");
  const url = new URL(req.url);
  const catalogs = await listCatalogs(user, {
    q: url.searchParams.get("q") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    houseId: url.searchParams.get("houseId") ?? undefined,
  });
  return json({ catalogs });
});

export const POST = route(async (req) => {
  const user = await authenticateUser(req, "catalog.edit");
  const input = await parseJson(req, catalogInputSchema);
  const catalog = await createCatalog(user, input);
  return json({ catalog }, { status: 201 });
});
