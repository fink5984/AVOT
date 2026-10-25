import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { setPrimary } from "@/server/services/assets";
import { getLotForUser } from "@/server/services/lots";

/** Primary photo of the book; `?lotId=` sets only that catalog lot's primary photo. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "photo.organize");
  const { id } = await params;
  const lotId = new URL(req.url).searchParams.get("lotId");
  if (lotId) await getLotForUser(user, lotId);
  await setPrimary(user, id, lotId);
  return json({ ok: true });
});
