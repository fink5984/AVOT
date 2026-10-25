import "server-only";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { API_VERSION, type HeartbeatInput, type pairDeviceSchema } from "@avot/shared";
import { db } from "../db";
import { encryptSecret, randomToken, sha256Hex } from "../crypto";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { DevicePrincipal, UserPrincipal } from "../auth/principal";

const PAIRING_TTL_MS = 15 * 60 * 1000;

export async function createPairingCode(user: UserPrincipal, deviceName: string) {
  const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
  const row = await db.pairingCode.create({
    data: {
      organizationId: user.organizationId,
      codeHash: sha256Hex(code),
      deviceName,
      createdById: user.userId,
      expiresAt: new Date(Date.now() + PAIRING_TTL_MS),
    },
  });
  await audit(user, { action: "device.pairing_code_created", entityType: "device", entityId: row.id, data: { deviceName } });
  return { code, expiresAt: row.expiresAt };
}

/** Called by the agent with the code the admin read off the screen. Single use. */
export async function pairDevice(input: z.infer<typeof pairDeviceSchema>) {
  if (input.apiVersion !== API_VERSION) {
    throw new AppError("CONFLICT", `גרסת ה-API של התוכנה (${input.apiVersion}) אינה תואמת לשרת (${API_VERSION}). עדכנו את Capture Agent.`);
  }
  const token = randomToken(32);
  const secret = randomToken(32);
  const result = await db.$transaction(async (tx) => {
    const pc = await tx.pairingCode.findUnique({ where: { codeHash: sha256Hex(input.code) } });
    if (!pc || pc.usedAt || pc.expiresAt < new Date()) throw new AppError("UNAUTHENTICATED", "קוד הצימוד שגוי או שפג תוקפו");
    const device = await tx.device.create({
      data: {
        organizationId: pc.organizationId,
        name: input.name || pc.deviceName,
        machineName: input.machineName,
        agentVersion: input.agentVersion,
        apiVersion: input.apiVersion,
        tokenHash: sha256Hex(token),
        secretEnc: encryptSecret(secret),
        lastSeenAt: new Date(),
      },
    });
    await tx.pairingCode.update({ where: { id: pc.id }, data: { usedAt: new Date(), deviceId: device.id } });
    await tx.auditLog.create({
      data: {
        organizationId: pc.organizationId,
        userId: pc.createdById,
        deviceId: device.id,
        action: "device.paired",
        entityType: "device",
        entityId: device.id,
        data: { name: device.name, machineName: input.machineName, agentVersion: input.agentVersion },
      },
    });
    return device;
  });
  return { deviceId: result.id, organizationId: result.organizationId, deviceToken: token, deviceSecret: secret, name: result.name };
}

export async function recordHeartbeat(device: DevicePrincipal, hb: HeartbeatInput) {
  const updated = await db.device.update({
    where: { id: device.deviceId },
    data: {
      agentVersion: hb.agentVersion,
      apiVersion: hb.apiVersion,
      cameraKind: hb.cameraKind,
      cameraModel: hb.cameraModel,
      cameraConnected: hb.cameraConnected,
      storagePath: hb.storagePath,
      freeDiskBytes: BigInt(hb.freeDiskBytes),
      pendingUploads: hb.pendingUploads,
      failedUploads: hb.failedUploads,
      lastSyncAt: hb.lastSyncAt ? new Date(hb.lastSyncAt) : undefined,
      lastError: hb.lastError,
      controllingUserId: hb.controllingUserId,
      lastSeenAt: new Date(),
    },
  });
  return { serverTime: new Date().toISOString(), apiVersion: API_VERSION, name: updated.name, revoked: !!updated.revokedAt };
}

export const deviceUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  assignedUserId: z.string().uuid().nullable().optional(),
});

export async function updateDevice(user: UserPrincipal, id: string, input: z.infer<typeof deviceUpdateSchema>) {
  const device = await db.device.findFirst({ where: { id, organizationId: user.organizationId } });
  if (!device) throw notFound("עמדת הצילום");
  if (input.assignedUserId) {
    const u = await db.user.findFirst({ where: { id: input.assignedUserId, organizationId: user.organizationId } });
    if (!u) throw notFound("המשתמש");
  }
  const updated = await db.device.update({ where: { id }, data: input });
  await audit(user, { action: "device.updated", entityType: "device", entityId: id, data: input as object });
  return updated;
}

export async function revokeDevice(user: UserPrincipal, id: string) {
  const device = await db.device.findFirst({ where: { id, organizationId: user.organizationId } });
  if (!device) throw notFound("עמדת הצילום");
  await db.device.update({ where: { id }, data: { revokedAt: new Date() } });
  await audit(user, { action: "device.revoked", entityType: "device", entityId: id, data: { name: device.name } });
}

export const ONLINE_WINDOW_MS = 90 * 1000;
export const isOnline = (lastSeenAt: Date | null) => !!lastSeenAt && Date.now() - lastSeenAt.getTime() < ONLINE_WINDOW_MS;
