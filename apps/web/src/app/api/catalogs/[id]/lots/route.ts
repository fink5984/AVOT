import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { createLot, listLots, lotInputSchema } from "@/server/services/lots";
import { getCatalogForUser } from "@/server/services/catalogs";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "catalog.view");
  const { id } = await params;
  const url = new URL(req.url);
  await getCatalogForUser(user, id);
  const lots = await listLots(user, id, {
    q: url.searchParams.get("q") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    sort: url.searchParams.get("sort") ?? undefined,
  });
  return json({ lots });
});

export const POST = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "lot.create");
  const { id } = await params;
  const lot = await createLot(user, id, await parseJson(req, lotInputSchema));
  return json({ lot }, { status: 201 });
});
