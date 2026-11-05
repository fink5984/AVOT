import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { photographerNotesSchema, readPhotographerNotes, savePhotographerNotes } from "@/server/services/photographer-notes";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "inventory.view");
  return json(await readPhotographerNotes(user.organizationId, (await params).id));
});

/** Autosave of the photographer's notes. Needs only photographerNotes.edit — not the right to edit the book. */
export const PUT = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "photographerNotes.edit");
  return json(await savePhotographerNotes(user, (await params).id, await parseJson(req, photographerNotesSchema)));
});
