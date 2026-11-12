import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { commitImport, discardImport, mappingSchema, previewImport, saveTemplate } from "@/server/services/sale-import";

const bodySchema = z.object({
  action: z.enum(["preview", "commit", "saveTemplate"]),
  mapping: mappingSchema.optional(),
  templateName: z.string().trim().min(1).max(80).optional(),
});

/** preview (optionally with a corrected mapping) / commit / save the mapping as a template */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "sales.import");
  const { id } = await params;
  const body = bodySchema.parse(await req.json().catch(() => ({})));
  if (body.action === "commit") return json(await commitImport(user, id));
  if (body.action === "saveTemplate") {
    if (!body.mapping || !body.templateName) return json({ error: { code: "VALIDATION", message: "חסר מיפוי או שם" } }, { status: 400 });
    const t = await saveTemplate(user, body.templateName, "RESULTS", body.mapping as never);
    return json({ template: { id: t.id, name: t.name } });
  }
  return json(await previewImport(user, id, body.mapping as never));
});

export const DELETE = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "sales.import");
  await discardImport(user, (await params).id);
  return json({ ok: true });
});
