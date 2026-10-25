import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { catalogInputSchema, deleteCatalog, updateCatalog } from "@/server/services/catalogs";

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
  await deleteCatalog(user, id);
  return json({ ok: true });
});
