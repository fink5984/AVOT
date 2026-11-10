import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { forbidden, notFound } from "@/server/errors";
import { json, parseJson, route } from "@/server/http";
import { getItemDetail, itemPatchSchema, photoStatusSchema, setItemPhotoStatus, updateItem } from "@/server/services/inventory";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "inventory.view");
  const detail = await getItemDetail(user, (await params).id);
  if (!detail) throw notFound("הספר");
  return json({ item: detail.item, lots: detail.lots.map((l) => (l.hidden ? { id: l.id, hidden: true, assignmentStatus: l.assignmentStatus } : l)) });
});

/**
 * Bibliographic edits need inventory.edit; marking photo progress only needs lot.status (photographers).
 * `expectedVersion` (the review panel's autosave): refused with 409 when the details changed since they were loaded.
 */
export const PATCH = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req);
  const { id } = await params;
  const input = await parseJson(req, itemPatchSchema.extend({ photoStatus: photoStatusSchema.optional(), expectedVersion: z.number().int().min(0).optional(), editSource: z.enum(["manual", "ai"]).optional() }));
  const { photoStatus, expectedVersion, editSource, ...fields } = input;
  if (photoStatus) {
    if (!can(user.role, "lot.status")) throw forbidden();
    await setItemPhotoStatus(user, id, photoStatus);
  }
  if (Object.keys(fields).length) {
    if (!can(user.role, "inventory.edit")) throw forbidden();
    const u = await updateItem(user, id, fields, { expectedVersion, source: editSource });
    return json({ ok: true, detailsVersion: u.detailsVersion, reviewStatus: u.reviewStatus });
  }
  return json({ ok: true });
});
