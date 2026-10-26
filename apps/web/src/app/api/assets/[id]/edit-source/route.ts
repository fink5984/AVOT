import { ROTATIONS } from "@avot/shared";
import { authenticateUser } from "@/server/auth/principal";
import { route } from "@/server/http";
import { editSource } from "@/server/services/book-processing";

export const runtime = "nodejs";

/** Oriented working copy (≈1400 px) of the original for the correction editor. ?rotation=0|90|180|270 */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "photo.organize");
  const { id } = await params;
  const r = Number(new URL(req.url).searchParams.get("rotation"));
  const rotation = (ROTATIONS as readonly number[]).includes(r) && new URL(req.url).searchParams.has("rotation") ? (r as (typeof ROTATIONS)[number]) : undefined;
  const jpeg = await editSource(user.organizationId, id, rotation);
  return new Response(new Uint8Array(jpeg), { headers: { "content-type": "image/jpeg", "cache-control": "private, no-store" } });
});
