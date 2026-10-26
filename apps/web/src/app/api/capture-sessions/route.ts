import { z } from "zod";
import { PHOTO_CATEGORIES } from "@avot/shared";
import { authenticateUser } from "@/server/auth/principal";
import { db } from "@/server/db";
import { notFound } from "@/server/errors";
import { json, parseJson, route } from "@/server/http";
import { resolveItemTarget } from "@/server/services/inventory";

const schema = z.object({
  lotId: z.string().uuid(),
  category: z.enum(PHOTO_CATEGORIES),
  cameraKind: z.enum(["WEBCAM", "CANON", "DIGICAM", "SIMULATOR", "AGENT_SIMULATOR"]),
  cameraName: z.string().max(200).nullish(),
  deviceId: z.string().uuid().nullish(),
});

/** Opens a capture session (one per user at a time; older ones are closed). */
export const POST = route(async (req) => {
  const user = await authenticateUser(req, "photo.capture");
  const input = await parseJson(req, schema);
  // `lotId` is the capture target: a catalog lot or an inventory book
  const target = await resolveItemTarget(user.organizationId, input.lotId);
  if (!target) throw notFound("הפריט");
  if (input.deviceId) {
    const d = await db.device.findFirst({ where: { id: input.deviceId, organizationId: user.organizationId } });
    if (!d) throw notFound("עמדת הצילום");
  }
  const [, session] = await db.$transaction([
    db.captureSession.updateMany({
      where: { userId: user.userId, status: "ACTIVE" },
      data: { status: "ENDED", endedAt: new Date() },
    }),
    db.captureSession.create({
      data: {
        organizationId: user.organizationId,
        userId: user.userId,
        deviceId: input.deviceId ?? null,
        cameraKind: input.cameraKind,
        cameraName: input.cameraName ?? null,
        inventoryItemId: target.itemId,
        catalogId: target.lot?.catalogId ?? null,
        lotId: target.lot?.id ?? null,
        activeCategory: input.category,
      },
    }),
  ]);
  return json({ session: { id: session.id } }, { status: 201 });
});
