import { authenticateUser } from "@/server/auth/principal";
import { forbidden } from "@/server/errors";
import { canUser } from "@/server/auth/permissions";
import { json, parseJson, route } from "@/server/http";
import { draftActionSchema, resolveCatalogDraft } from "@/server/services/lot-draft-actions";

/** Explicitly join a lot's dedicated catalog text with its book's draft (either direction). Never done silently. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "lot.edit");
  const input = await parseJson(req, draftActionSchema);
  if (input.direction === "lot_to_book" && !canUser(user, "inventory.edit")) throw forbidden();
  return json(await resolveCatalogDraft(user, (await params).id, input));
});
