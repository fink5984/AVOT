import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { paymentSchema, recordPayment } from "@/server/services/sales";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "payment.manage");
  const r = await recordPayment(user, (await params).id, await parseJson(req, paymentSchema));
  return json({ paymentId: r.payment.id, ledger: r.ledger }, { status: 201 });
});
