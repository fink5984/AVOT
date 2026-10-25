import { authenticate } from "@/server/auth/principal";
import { notFound } from "@/server/errors";
import { json, route } from "@/server/http";
import { captureStatus } from "@/server/services/captures";

/** Reconciliation: what does the server hold for this capture id? */
export const GET = route<{ params: Promise<{ captureId: string }> }>(async (req, { params }) => {
  const principal = await authenticate(req, { allowDevice: true });
  const { captureId } = await params;
  const status = await captureStatus(principal, captureId);
  if (!status) throw notFound("הצילום");
  return json(status);
});
