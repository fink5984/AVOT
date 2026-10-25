/**
 * Creates the organization (first run) and an administrator account.
 *
 *   npm run create-admin                       # interactive
 *   ADMIN_EMAIL=… ADMIN_NAME=… ADMIN_PASSWORD=… npm run create-admin   # non-interactive (Railway shell / CI)
 */
import { randomBytes, scrypt } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

function hash(password: string): Promise<string> {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(`scrypt$32768$8$1$${salt.toString("base64")}$${key.toString("base64")}`),
    ),
  );
}

async function main() {
  let email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  let name = process.env.ADMIN_NAME?.trim();
  let password = process.env.ADMIN_PASSWORD;

  if (!email || !name || !password) {
    if (!process.stdin.isTTY) {
      console.error("Set ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD, or run interactively.");
      process.exit(1);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    email ||= (await rl.question("אימייל מנהל: ")).trim().toLowerCase();
    name ||= (await rl.question("שם מלא: ")).trim();
    password ||= await rl.question("סיסמה (10 תווים לפחות): ");
    rl.close();
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("כתובת אימייל לא תקינה");
  if (!password || password.length < 10) throw new Error("הסיסמה חייבת להכיל לפחות 10 תווים");

  let org = await db.organization.findFirst({ orderBy: { createdAt: "asc" } });
  if (!org) {
    org = await db.organization.create({ data: { name: "אבות | AVOT", slug: "avot" } });
    console.log(`נוצר ארגון: ${org.name}`);
  }

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    await db.user.update({ where: { id: existing.id }, data: { role: "ADMIN", status: "ACTIVE", passwordHash: await hash(password) } });
    console.log(`המשתמש ${email} עודכן למנהל מערכת.`);
  } else {
    await db.user.create({
      data: { organizationId: org.id, email, name: name || email, role: "ADMIN", status: "ACTIVE", passwordHash: await hash(password) },
    });
    console.log(`נוצר מנהל מערכת: ${email}`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
