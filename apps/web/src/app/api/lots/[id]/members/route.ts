import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { addBooksSchema, addBooksToLot, lotCandidates, reorderLotMembers, reorderMembersSchema } from "@/server/services/lot-members";

type Ctx = { params: Promise<{ id: string }> };

/** Books that may join this lot (same catalog, same consignor). */
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "catalog.view");
  const q = new URL(req.url).searchParams.get("q") ?? undefined;
  return json(await lotCandidates(user, (await params).id, q));
});

/** "הוסף ספר ללוט". */
export const POST = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "catalog.assign");
  return json(await addBooksToLot(user, (await params).id, await parseJson(req, addBooksSchema)));
});

/** Order of the books inside the lot. */
export const PUT = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "catalog.assign");
  const { orderedItemIds } = await parseJson(req, reorderMembersSchema);
  await reorderLotMembers(user, (await params).id, orderedItemIds);
  return json({ ok: true });
});
