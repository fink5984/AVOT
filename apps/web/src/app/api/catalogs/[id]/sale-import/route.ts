import { authenticateUser } from "@/server/auth/principal";
import { AppError } from "@/server/errors";
import { json, route } from "@/server/http";
import { createImport, listImports, listTemplates } from "@/server/services/sale-import";

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "sales.import");
  const { id } = await params;
  return json({ imports: await listImports(user, id), templates: await listTemplates(user.organizationId) });
});

/** multipart: file (XLSX / CSV), optional buyers (a second file), optional templateId */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "sales.import");
  const { id } = await params;
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new AppError("VALIDATION", "לא נבחר קובץ");
  const buyers = form?.get("buyers");
  const templateId = form?.get("templateId");
  const r = await createImport(user, id, {
    fileName: file.name,
    buffer: Buffer.from(await file.arrayBuffer()),
    buyers: buyers instanceof File && buyers.size ? { fileName: buyers.name, buffer: Buffer.from(await buyers.arrayBuffer()) } : null,
    templateId: typeof templateId === "string" && templateId ? templateId : null,
  });
  return json(r, { status: 201 });
});
