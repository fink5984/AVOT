import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { patchNoteSchema, updateReviewNote } from "@/server/services/review-notes";

type Ctx = { params: Promise<{ id: string }> };

/** Edit an open note, or handle it (נבדק ואומת / נבדק ולא אומת, with a conclusion) or reopen it. Refused when it changed meanwhile. */
export const PATCH = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "reviewNote.add");
  const { id } = await params;
  return json({ note: await updateReviewNote(user, id, await parseJson(req, patchNoteSchema)) });
});
