import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { canUser } from "@/server/auth/permissions";
import { forbidden } from "@/server/errors";
import { json, parseJson, route } from "@/server/http";
import { approveReview, startReview } from "@/server/services/item-review";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  /** "סיום בדיקה ואישור": the only way to APPROVED; needs the final-approval permission, checked here on the server */
  z.object({ action: z.literal("approve"), detailsVersion: z.number().int().min(0) }),
]);

export const POST = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "item.review");
  const { id } = await params;
  const input = await parseJson(req, schema);
  if (input.action === "start") return json(await startReview(user, id));
  // an editor with item.review may start a review but never approve it, however the request is made
  if (!canUser(user, "item.review.approve")) throw forbidden();
  return json(await approveReview(user, id, { detailsVersion: input.detailsVersion }));
});
