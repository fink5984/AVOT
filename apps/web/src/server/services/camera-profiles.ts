import "server-only";
import { Prisma } from "@prisma/client";
import {
  DEFAULT_PROCESSING,
  DEFAULT_PROFILE_NAME,
  cameraProfileSettingsSchema,
  type CameraProfileInput,
  type CameraProfileSettings,
  type ProcessingSettings,
} from "@avot/shared";
import { db } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { UserPrincipal } from "../auth/principal";

export interface CameraProfileDto {
  id: string;
  name: string;
  isDefault: boolean;
  settings: CameraProfileSettings;
  updatedAt: string;
}

function toDto(p: { id: string; name: string; isDefault: boolean; settings: unknown; updatedAt: Date }): CameraProfileDto {
  // tolerate older / partial JSON: missing fields fall back to the defaults
  const parsed = cameraProfileSettingsSchema.safeParse(p.settings);
  return {
    id: p.id,
    name: p.name,
    isDefault: p.isDefault,
    settings: parsed.success ? parsed.data : { processing: DEFAULT_PROCESSING, camera: {} },
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** Profiles of the organization. The default profile is created on first use so the capture screen always has one. */
export async function listProfiles(orgId: string): Promise<CameraProfileDto[]> {
  let rows = await db.cameraProfile.findMany({ where: { organizationId: orgId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
  if (rows.length === 0) {
    try {
      await db.cameraProfile.create({
        data: { organizationId: orgId, name: DEFAULT_PROFILE_NAME, isDefault: true, settings: { processing: DEFAULT_PROCESSING, camera: {} } },
      });
    } catch (err) {
      // a concurrent first request created it
      if ((err as { code?: string }).code !== "P2002") throw err;
    }
    rows = await db.cameraProfile.findMany({ where: { organizationId: orgId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
  }
  return rows.map(toDto);
}

/** The default profile's processing settings, or null when no profile exists yet (nothing is processed then). */
export async function defaultProcessing(orgId: string): Promise<ProcessingSettings | null> {
  const row = await db.cameraProfile.findFirst({ where: { organizationId: orgId, isDefault: true } });
  return row ? toDto(row).settings.processing : null;
}

export async function createProfile(user: UserPrincipal, input: CameraProfileInput): Promise<CameraProfileDto> {
  try {
    const row = await db.$transaction(async (tx) => {
      if (input.isDefault) await tx.cameraProfile.updateMany({ where: { organizationId: user.organizationId, isDefault: true }, data: { isDefault: false } });
      return tx.cameraProfile.create({
        data: { organizationId: user.organizationId, name: input.name, isDefault: !!input.isDefault, settings: input.settings as unknown as Prisma.InputJsonValue },
      });
    });
    await audit(user, { action: "profile.created", entityType: "camera_profile", entityId: row.id, data: { name: row.name } });
    return toDto(row);
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new AppError("CONFLICT", "כבר קיים פרופיל בשם זה");
    throw err;
  }
}

export async function updateProfile(user: UserPrincipal, id: string, input: Partial<CameraProfileInput>): Promise<CameraProfileDto> {
  const existing = await db.cameraProfile.findFirst({ where: { id, organizationId: user.organizationId } });
  if (!existing) throw notFound("הפרופיל");
  if (input.isDefault === false && existing.isDefault) throw new AppError("VALIDATION", "יש לבחור פרופיל ברירת מחדל אחר במקום זה");
  try {
    const row = await db.$transaction(async (tx) => {
      if (input.isDefault) await tx.cameraProfile.updateMany({ where: { organizationId: user.organizationId, isDefault: true, id: { not: id } }, data: { isDefault: false } });
      return tx.cameraProfile.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.settings !== undefined ? { settings: input.settings as unknown as Prisma.InputJsonValue } : {}),
          ...(input.isDefault ? { isDefault: true } : {}),
        },
      });
    });
    await audit(user, { action: "profile.updated", entityType: "camera_profile", entityId: id, data: { name: row.name, isDefault: row.isDefault } });
    return toDto(row);
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new AppError("CONFLICT", "כבר קיים פרופיל בשם זה");
    throw err;
  }
}

export async function deleteProfile(user: UserPrincipal, id: string): Promise<void> {
  const existing = await db.cameraProfile.findFirst({ where: { id, organizationId: user.organizationId } });
  if (!existing) throw notFound("הפרופיל");
  if (existing.isDefault) throw new AppError("VALIDATION", "לא ניתן למחוק את פרופיל ברירת המחדל");
  await db.cameraProfile.delete({ where: { id } });
  await audit(user, { action: "profile.deleted", entityType: "camera_profile", entityId: id, data: { name: existing.name } });
}
