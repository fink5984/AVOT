import { LABEL_TYPES, labelProfileSchema, type LabelProfile, type LabelType } from "@avot/shared";
import { authenticateUser } from "@/server/auth/principal";
import { AppError } from "@/server/errors";
import { route } from "@/server/http";
import { previewLabel } from "@/server/services/label-templates";

/**
 * PNG of a label made by the real layout engine: `?type=BOOK|LOCATION|ZONE&stock=57x32&dpm=8&profile=<json>`.
 * `profile` = settings being edited and not saved yet. Numbers describing the barcode come back in headers.
 */
export const GET = route(async (req) => {
  const user = await authenticateUser(req, "label.print");
  const p = new URL(req.url).searchParams;
  const type = (p.get("type") ?? "BOOK").toUpperCase();
  if (!(LABEL_TYPES as readonly string[]).includes(type)) throw new AppError("VALIDATION", "סוג תווית לא מוכר");
  let profile: Partial<LabelProfile> | undefined;
  const raw = p.get("profile");
  if (raw) {
    try {
      profile = labelProfileSchema.partial().parse(JSON.parse(raw));
    } catch {
      throw new AppError("VALIDATION", "הגדרות התווית אינן תקינות");
    }
  }
  const { png, info } = await previewLabel(user.organizationId, { type: type as LabelType, stock: p.get("stock") ?? "57x32", dotsPerMm: p.get("dpm") === "12" ? 12 : 8, profile });
  return new Response(new Uint8Array(png), {
    headers: { "content-type": "image/png", "cache-control": "no-store", "x-label-info": encodeURIComponent(JSON.stringify(info)) },
  });
});
