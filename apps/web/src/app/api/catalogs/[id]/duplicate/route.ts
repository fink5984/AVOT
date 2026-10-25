import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { duplicateCatalog } from "@/server/services/catalogs";

const schema = z.object({ number: z.string().trim().min(1).max(30), name: z.string().trim().min(1).max(200) });

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "catalog.edit");
  const { id } = await params;
  const catalog = await duplicateCatalog(user, id, await parseJson(req, schema));
  return json({ catalog }, { status: 201 });
});
