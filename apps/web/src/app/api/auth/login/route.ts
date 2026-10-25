import { z } from "zod";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { clientIp, json, parseJson, route } from "@/server/http";
import { assertFailureBudget, recordFailure } from "@/server/rate-limit";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/session";

const schema = z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().min(1).max(200) });

const WINDOW = 15 * 60 * 1000;

// computed once; used to keep response time similar for unknown emails
let dummyHash: Promise<string> | undefined;

export const POST = route(async (req) => {
  const ip = clientIp(req);
  const { email, password } = await parseJson(req, schema);
  const ipKey = `login:ip:${ip}`;
  const emailKey = `login:email:${email}`;
  assertFailureBudget(ipKey, 30, WINDOW);
  assertFailureBudget(emailKey, 8, WINDOW);

  const user = await db.user.findUnique({ where: { email } });
  const ok = user?.passwordHash
    ? await verifyPassword(password, user.passwordHash)
    : (await verifyPassword(password, await (dummyHash ??= hashPassword("not-a-real-password"))), false);

  if (!user || !ok) {
    recordFailure(ipKey, WINDOW);
    recordFailure(emailKey, WINDOW);
    throw new AppError("UNAUTHENTICATED", "אימייל או סיסמה שגויים");
  }
  if (user.status !== "ACTIVE") throw new AppError("FORBIDDEN", "החשבון הושבת. פנו למנהל המערכת.");

  await createSession(user.id, { ip, userAgent: req.headers.get("user-agent") });
  await db.auditLog.create({
    data: { organizationId: user.organizationId, userId: user.id, action: "session.login", entityType: "session", data: { ip } },
  });
  return json({ ok: true });
});
