import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { commercialSchema, setLotCommercialStatus } from "@/server/services/assignments";

/** offered / sold / unsold / withdrawn — sold creates a pick task. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "commercial.edit");
  return json({ lot: await setLotCommercialStatus(user, (await params).id, await parseJson(req, commercialSchema)) });
});
