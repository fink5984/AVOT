import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { setShelfActive, shelfContents } from "@/server/services/warehouse";

type Ctx = { params: Promise<{ id: string }> };

/** The books on a shelf. */
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "warehouse.view");
  return json(await shelfContents(user.organizationId, (await params).id));
});

export const PATCH = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "warehouse.manage");
  const { active } = await parseJson(req, z.object({ active: z.boolean() }));
  await setShelfActive(user, (await params).id, active);
  return json({ ok: true });
});
