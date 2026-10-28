import { authenticateUser } from "@/server/auth/principal";
import { AppError } from "@/server/errors";
import { route } from "@/server/http";
import { previewLabel } from "@/server/services/label-templates";
import { contentFor } from "@/server/services/printing";

/** `?type=BOOK|LOCATION|ZONE&id=<uuid>&stock=57x32` — one real label, drawn by the same engine as the printer. */
export const GET = route(async (req) => {
  const user = await authenticateUser(req, "label.print");
  const p = new URL(req.url).searchParams;
  const type = (p.get("type") ?? "").toUpperCase();
  const id = p.get("id") ?? "";
  if (!["BOOK", "LOCATION", "ZONE"].includes(type) || !/^[0-9a-f-]{36}$/i.test(id)) throw new AppError("VALIDATION", "בקשה לא תקינה");
  const content = await contentFor(user.organizationId, type as "BOOK" | "LOCATION" | "ZONE", id);
  if (!content) throw new AppError("NOT_FOUND", "התווית לא נמצאה");
  const { png } = await previewLabel(user.organizationId, { type: type as "BOOK" | "LOCATION" | "ZONE", stock: p.get("stock") ?? "57x32", dotsPerMm: p.get("dpm") === "12" ? 12 : 8, content, scale: 4 });
  return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "private, max-age=60" } });
});
