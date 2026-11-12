import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { releasePurchase } from "@/server/services/sales";

/** sold → released to the picking queue. An unpaid sale needs the separate permission (checked in the service). */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "pick.release");
  const text = await req.text();
  const body = text.trim() ? z.object({ note: z.string().trim().max(300).nullish() }).parse(JSON.parse(text)) : {};
  const r = await releasePurchase(user, (await params).id, body);
  return json({ released: r.released });
});
