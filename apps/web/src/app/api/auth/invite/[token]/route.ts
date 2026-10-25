import { z } from "zod";
import { clientIp, json, parseJson, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { acceptInvite } from "@/server/services/users";
import { createSession } from "@/server/auth/session";

const schema = z.object({ password: z.string().min(1).max(200) });

export const POST = route<{ params: Promise<{ token: string }> }>(async (req, { params }) => {
  rateLimit(`invite:${clientIp(req)}`, 10, 15 * 60 * 1000);
  const { token } = await params;
  const { password } = await parseJson(req, schema);
  const user = await acceptInvite(token, password);
  await createSession(user.id, { ip: clientIp(req), userAgent: req.headers.get("user-agent") });
  return json({ ok: true });
});
