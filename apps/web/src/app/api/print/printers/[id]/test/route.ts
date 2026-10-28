import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { createTestPrint } from "@/server/services/printing";

/** `?kind=BOOK|LOCATION|ZONE` prints a sample of that label type with the saved calibration; no kind = the generic test label. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "print.manage");
  const k = (new URL(req.url).searchParams.get("kind") ?? "").toUpperCase();
  const job = await createTestPrint(user, (await params).id, k === "BOOK" || k === "LOCATION" || k === "ZONE" ? k : "TEST");
  return json({ job: { id: job.id, status: job.status } }, { status: 201 });
});
