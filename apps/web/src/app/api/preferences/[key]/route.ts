import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { db } from "@/server/db";
import { json, parseJson, route } from "@/server/http";

const KEYS = z.enum(["capture", "workPosition", "ui"]);
const schema = z.object({ value: z.record(z.string(), z.unknown()) });

type Ctx = { params: Promise<{ key: string }> };

export const GET = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req);
  const key = KEYS.parse((await params).key);
  const pref = await db.userPreference.findUnique({ where: { userId_key: { userId: user.userId, key } } });
  return json({ value: pref?.value ?? null });
});

export const PUT = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req);
  const key = KEYS.parse((await params).key);
  const { value } = await parseJson(req, schema);
  if (JSON.stringify(value).length > 20_000) return json({ error: { code: "VALIDATION", message: "ערך גדול מדי" } }, { status: 400 });
  await db.userPreference.upsert({
    where: { userId_key: { userId: user.userId, key } },
    create: { userId: user.userId, key, value: value as object },
    update: { value: value as object },
  });
  return json({ ok: true });
});
