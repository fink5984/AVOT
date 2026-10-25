import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { resetLotDisplay, setLotAssetHidden } from "@/server/services/assets";
import { getLotForUser } from "@/server/services/lots";

const schema = z.union([z.object({ assetId: z.string().uuid(), hidden: z.boolean() }), z.object({ reset: z.literal(true) })]);

/** This catalog lot's presentation of the book's photos: hide / show one, or reset to the book's order. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "lot.edit");
  const { id } = await params;
  await getLotForUser(user, id);
  const input = await parseJson(req, schema);
  if ("reset" in input) await resetLotDisplay(user, id);
  else await setLotAssetHidden(user, id, input.assetId, input.hidden);
  return json({ ok: true });
});
