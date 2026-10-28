import "server-only";
import { z } from "zod";
import { DEFAULT_LABEL_PROFILES, LABEL_STOCKS, LABEL_TYPES, labelProfileSchema, layoutLabel, resolveProfile, type LabelContent, type LabelProfilesOverrides, type LabelType } from "@avot/shared";
import { db } from "../db";
import { audit } from "../audit";
import { AppError } from "../errors";
import type { UserPrincipal } from "../auth/principal";
import { renderLabel, renderLabelPng } from "../labels/render";

/**
 * Label calibration: one profile per label type for the whole organization. Printing from the inventory table, a book
 * page, the warehouse, the shelf pages, the test print and the preview all read the same stored profile — there is
 * no other place a label's look is defined.
 */

export async function getLabelProfiles(orgId: string): Promise<LabelProfilesOverrides> {
  const rows = await db.labelTemplate.findMany({ where: { organizationId: orgId } });
  const out: LabelProfilesOverrides = {};
  for (const r of rows) {
    if (!(LABEL_TYPES as readonly string[]).includes(r.type)) continue;
    const parsed = labelProfileSchema.partial().safeParse(r.profile);
    if (parsed.success) out[r.type as LabelType] = parsed.data;
  }
  return out;
}

export async function listLabelTemplates(orgId: string) {
  const overrides = await getLabelProfiles(orgId);
  return LABEL_TYPES.map((type) => ({ type, profile: resolveProfile(type, overrides), defaults: DEFAULT_LABEL_PROFILES[type], customised: !!overrides[type] }));
}

export const saveTemplateSchema = z.object({ profile: labelProfileSchema.partial() });

export async function saveLabelTemplate(user: UserPrincipal, type: LabelType, input: z.infer<typeof saveTemplateSchema>) {
  const profile = labelProfileSchema.parse({ ...DEFAULT_LABEL_PROFILES[type], ...input.profile });
  await db.labelTemplate.upsert({
    where: { organizationId_type: { organizationId: user.organizationId, type } },
    create: { organizationId: user.organizationId, type, profile, updatedById: user.userId },
    update: { profile, updatedById: user.userId },
  });
  await audit(user, { action: "print.template_saved", entityType: "settings", entityId: user.organizationId, data: { type, profile } });
  return profile;
}

export async function resetLabelTemplate(user: UserPrincipal, type: LabelType) {
  await db.labelTemplate.deleteMany({ where: { organizationId: user.organizationId, type } });
  await audit(user, { action: "print.template_reset", entityType: "settings", entityId: user.organizationId, data: { type } });
  return DEFAULT_LABEL_PROFILES[type];
}

/** Content for the preview and for "הדפסת ניסיון" of each type: realistic Hebrew, a long name, an 8-digit number. */
export function sampleLabel(type: LabelType | "TEST"): LabelContent {
  switch (type) {
    case "BOOK":
      return { type: "BOOK", code: "10000041", inventoryNumber: "10000041", title: "שולחן ערוך — אורח חיים, עם פירוש משנה ברורה ובאר היטב (דפוס וילנא)" };
    case "LOCATION":
      return { type: "LOCATION", code: "LOC-W1-C4-04", shelf: "מדף 4", path: "מחסן 1 › עמודה 4" };
    case "ZONE":
      return { type: "ZONE", code: "COL-W1-C4", name: "עמודה 4", warehouse: "מחסן 1" };
    default:
      return { type: "TEST", text: "AVOT · בדיקת הדפסה" };
  }
}

/**
 * The preview: the real layout engine and the real rasteriser, drawn to a PNG. `profile` carries the settings that are
 * being edited and not saved yet; without it the saved calibration is shown.
 */
export async function previewLabel(
  orgId: string,
  opts: { type: LabelType; stock: string; dotsPerMm: 8 | 12; profile?: Partial<z.infer<typeof labelProfileSchema>>; content?: LabelContent; scale?: number },
) {
  const stock = LABEL_STOCKS[opts.stock];
  if (!stock) throw new AppError("VALIDATION", "גודל מדבקה לא מוכר");
  const profile = opts.profile ? labelProfileSchema.parse({ ...DEFAULT_LABEL_PROFILES[opts.type], ...opts.profile }) : resolveProfile(opts.type, await getLabelProfiles(orgId));
  const layout = layoutLabel(opts.content ?? sampleLabel(opts.type), stock, profile);
  const rendered = await renderLabel(layout, opts.dotsPerMm);
  return {
    png: await renderLabelPng(rendered, opts.scale ?? 3),
    info: { widthMm: stock.widthMm, heightMm: stock.heightMm, dotsPerMm: opts.dotsPerMm, barcodeModuleMm: rendered.barcode ? Math.round((rendered.barcode.moduleDots / opts.dotsPerMm) * 100) / 100 : null, barcodeWidthMm: rendered.barcode ? Math.round((rendered.barcode.widthDots / opts.dotsPerMm) * 10) / 10 : null, barcodeFits: rendered.barcode?.fits ?? true },
  };
}
