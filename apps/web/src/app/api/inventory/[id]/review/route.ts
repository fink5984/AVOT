import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { approveReview, startReview } from "@/server/services/item-review";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  /** "סיימתי לבדוק - אשר פרטים": the only way to APPROVED */
  z.object({ action: z.literal("approve"), detailsVersion: z.number().int().min(0) }),
]);

export const POST = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "item.review");
  const { id } = await params;
  const input = await parseJson(req, schema);
  return json(input.action === "start" ? await startReview(user, id) : await approveReview(user, id, { detailsVersion: input.detailsVersion }));
});
