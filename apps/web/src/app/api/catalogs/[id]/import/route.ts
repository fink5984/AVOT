import { authenticateUser } from "@/server/auth/principal";
import { AppError } from "@/server/errors";
import { json, route } from "@/server/http";
import { importLots } from "@/server/services/csv-import";

const MAX_BYTES = 2 * 1024 * 1024;

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "lot.create");
  const { id } = await params;
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const text = await req.text();
  if (text.length > MAX_BYTES) throw new AppError("PAYLOAD_TOO_LARGE", "קובץ ה-CSV גדול מדי (עד 2MB)");
  return json(await importLots(user, id, text, dryRun));
});
