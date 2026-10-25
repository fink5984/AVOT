import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { createPairingCode } from "@/server/services/devices";

const schema = z.object({ name: z.string().trim().min(1, "שם עמדה נדרש").max(100) });

export const POST = route(async (req) => {
  const admin = await authenticateUser(req, "device.manage");
  const { name } = await parseJson(req, schema);
  return json(await createPairingCode(admin, name), { status: 201 });
});
