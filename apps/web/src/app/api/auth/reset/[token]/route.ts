import { z } from "zod";
import { clientIp, json, parseJson, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { resetPassword } from "@/server/services/users";

const schema = z.object({ password: z.string().min(1).max(200) });

export const POST = route<{ params: Promise<{ token: string }> }>(async (req, { params }) => {
  rateLimit(`reset:${clientIp(req)}`, 10, 15 * 60 * 1000);
  const { token } = await params;
  const { password } = await parseJson(req, schema);
  await resetPassword(token, password);
  return json({ ok: true });
});
