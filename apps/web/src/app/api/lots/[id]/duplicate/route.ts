import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { duplicateLot } from "@/server/services/lots";

/** A second physical copy is a new book: the body must name its consignor (it is never copied from the first one). */
const bodySchema = z.object({ consignorId: z.string().uuid("מזהה מפקיד לא תקין").optional() });

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "lot.edit");
  const { id } = await params;
  const body = await parseJson(req, bodySchema);
  return json({ lot: await duplicateLot(user, id, body.consignorId) }, { status: 201 });
});
