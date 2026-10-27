import { authenticateUser } from "@/server/auth/principal";
import { db } from "@/server/db";
import { json, route } from "@/server/http";
import { isOnline } from "@/server/services/devices";

/** Stations visible to the capture screen. */
export const GET = route(async (req) => {
  const user = await authenticateUser(req, "photo.capture");
  const devices = await db.device.findMany({
    where: { organizationId: user.organizationId, revokedAt: null, kind: "CAPTURE" },
    orderBy: { name: "asc" },
  });
  return json({
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      online: isOnline(d.lastSeenAt),
      cameraKind: d.cameraKind,
      cameraModel: d.cameraModel,
      cameraConnected: d.cameraConnected,
      pendingUploads: d.pendingUploads,
      failedUploads: d.failedUploads,
      lastSyncAt: d.lastSyncAt?.toISOString() ?? null,
      lastError: d.lastError,
      agentVersion: d.agentVersion,
      assignedUserId: d.assignedUserId,
    })),
  });
});
