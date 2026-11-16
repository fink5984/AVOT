import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { addNoteSchema, addReviewNote, listReviewNotes } from "@/server/services/review-notes";
import { getItemOrThrow } from "@/server/services/inventory";

type Ctx = { params: Promise<{ id: string }> };

/** The book's "הערות לבדיקה" (the same list from the inventory and from any catalog). */
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "inventory.view");
  const { id } = await params;
  await getItemOrThrow(user.organizationId, id);
  return json({ notes: (await listReviewNotes(user.organizationId, [id])).get(id) ?? [] });
});

export const POST = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "reviewNote.add");
  const { id } = await params;
  return json({ note: await addReviewNote(user, id, await parseJson(req, addNoteSchema)) }, { status: 201 });
});
