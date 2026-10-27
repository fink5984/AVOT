import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { catalogInputSchema, updateCatalog } from "@/server/services/catalogs";
import { requestDeleteCatalogs } from "@/server/services/deletion";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "catalog.edit");
  const { id } = await params;
  const input = await parseJson(req, catalogInputSchema.partial());
  return json({ catalog: await updateCatalog(user, id, input) });
});

export const DELETE = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "catalog.delete");
  const { id } = await params;
  // books stay in inventory; the catalog and its assignments are removed by a durable job
  return json(await requestDeleteCatalogs(user, [id]), { status: 202 });
});
