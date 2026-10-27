import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { createTestPrint } from "@/server/services/printing";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "print.manage");
  const job = await createTestPrint(user, (await params).id);
  return json({ job: { id: job.id, status: job.status } }, { status: 201 });
});
