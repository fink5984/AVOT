import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { assignSchema, assignToCatalog } from "@/server/services/assignments";

/** Assign the book to a catalog of אבות / טבין (409 when it already has an active assignment, unless replaceActive). */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "catalog.assign");
  const lot = await assignToCatalog(user, (await params).id, await parseJson(req, assignSchema));
  return json({ lot }, { status: 201 });
});
