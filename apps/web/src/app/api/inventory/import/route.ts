import { authenticateUser } from "@/server/auth/principal";
import { AppError } from "@/server/errors";
import { json, route } from "@/server/http";
import { importItems } from "@/server/services/csv-import";

const MAX_BYTES = 2 * 1024 * 1024;

/** CSV import of books into inventory (no catalog). `?dryRun=1` validates only. */
export const POST = route(async (req) => {
  const user = await authenticateUser(req, "inventory.import");
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const text = await req.text();
  if (text.length > MAX_BYTES) throw new AppError("PAYLOAD_TOO_LARGE", "קובץ ה-CSV גדול מדי (עד 2MB)");
  return json(await importItems(user, text, dryRun));
});
