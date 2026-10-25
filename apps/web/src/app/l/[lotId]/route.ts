import { redirect } from "next/navigation";

/** Short link printed in lot-label QR codes: /l/<lotId> → the lot page (auth enforced there). Old labels keep working. */
export async function GET(_req: Request, { params }: { params: Promise<{ lotId: string }> }) {
  const { lotId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(lotId)) redirect("/");
  redirect(`/lots/${lotId}`);
}
