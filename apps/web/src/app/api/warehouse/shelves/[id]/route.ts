import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { renameShelf, setShelfActive, shelfContents, shelfRenameSchema } from "@/server/services/warehouse";

type Ctx = { params: Promise<{ id: string }> };

/** The books on a shelf. */
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "warehouse.view");
  return json(await shelfContents(user.organizationId, (await params).id));
});

/** { active } switches the shelf's location on / off; { name } renames the shelf (display name only). Both need warehouse.manage. */
export const PATCH = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "warehouse.manage");
  const body = await parseJson(req, z.object({ active: z.boolean().optional(), name: z.string().max(80).nullish() }).refine((b) => b.active !== undefined || b.name !== undefined, "חסר שדה לעדכון"));
  const { id } = await params;
  if (body.name !== undefined) return json(await renameShelf(user, id, shelfRenameSchema.parse({ name: body.name })));
  await setShelfActive(user, id, body.active!);
  return json({ ok: true });
});
