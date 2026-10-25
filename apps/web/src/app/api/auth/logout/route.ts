import { json, route } from "@/server/http";
import { destroyCurrentSession } from "@/server/auth/session";

export const POST = route(async () => {
  await destroyCurrentSession();
  return json({ ok: true });
});
