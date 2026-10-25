import { z } from "zod";
import { PHOTO_CATEGORIES } from "@avot/shared";
import { authenticateUser } from "@/server/auth/principal";
import { db } from "@/server/db";
import { notFound } from "@/server/errors";
import { json, parseJson, route } from "@/server/http";
import { resolveItemTarget } from "@/server/services/inventory";

const schema = z.object({
  activeCategory: z.enum(PHOTO_CATEGORIES).optional(),
  lotId: z.string().uuid().optional(),
  end: z.boolean().optional(),
});

export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "photo.capture");
  const { id } = await params;
  const input = await parseJson(req, schema);
  const session = await db.captureSession.findFirst({ where: { id, userId: user.userId } });
  if (!session) throw notFound("סשן הצילום");
  let target: Awaited<ReturnType<typeof resolveItemTarget>> = null;
  if (input.lotId) {
    target = await resolveItemTarget(user.organizationId, input.lotId);
    if (!target) throw notFound("הפריט");
  }
  await db.captureSession.update({
    where: { id },
    data: {
      activeCategory: input.activeCategory,
      ...(target ? { inventoryItemId: target.itemId, lotId: target.lot?.id ?? null, catalogId: target.lot?.catalogId ?? null } : {}),
      lastActivityAt: new Date(),
      ...(input.end ? { status: "ENDED", endedAt: new Date() } : {}),
    },
  });
  return json({ ok: true });
});
