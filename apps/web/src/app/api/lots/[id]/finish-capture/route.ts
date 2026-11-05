import { authenticateUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { forbidden } from "@/server/errors";
import { json, parseJson, route } from "@/server/http";
import { finishCapture, finishCaptureSchema } from "@/server/services/capture-finish";

/**
 * Finish a book in the capture studio (`id` is a catalog lot or an inventory item): marks the photography status and
 * queues ONE label. Idempotent on `opId`; retry with the same key after a timeout.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "lot.status");
  if (!can(user.role, "label.print")) throw forbidden();
  const { id } = await params;
  return json(await finishCapture(user, id, await parseJson(req, finishCaptureSchema)));
});
