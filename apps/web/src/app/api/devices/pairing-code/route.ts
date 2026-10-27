import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { createPairingCode } from "@/server/services/devices";

const schema = z
  .object({ name: z.string().trim().max(100).optional(), deviceId: z.string().uuid().optional(), kind: z.enum(["CAPTURE", "PRINT"]).optional() })
  .refine((v) => v.deviceId || v.name, { message: "שם העמדה נדרש", path: ["name"] });

export const POST = route(async (req) => {
  const admin = await authenticateUser(req, "device.manage");
  const { name, deviceId, kind } = await parseJson(req, schema);
  return json(await createPairingCode(admin, name ?? "", deviceId, kind ?? "CAPTURE"), { status: 201 });
});
