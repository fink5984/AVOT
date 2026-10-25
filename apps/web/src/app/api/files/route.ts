import { Readable } from "node:stream";
import { verifySignedPayload } from "@/server/crypto";
import { contentDisposition, json } from "@/server/http";
import { storage } from "@/server/storage";

export const runtime = "nodejs";

/**
 * Serves objects from the *local* storage driver through short-lived HMAC
 * signed links (the S3 driver hands out presigned URLs instead). Links are
 * minted only after an authenticated, permission-checked request.
 */
export async function GET(req: Request) {
  const t = new URL(req.url).searchParams.get("t") ?? "";
  const p = verifySignedPayload<{ k: string; fn?: string; inl?: boolean; ct?: string; exp: number }>(t);
  if (!p) return json({ error: { code: "FORBIDDEN", message: "הקישור אינו תקף או שפג תוקפו" } }, { status: 403 });
  const store = storage();
  if (store.driver !== "local") return json({ error: { code: "NOT_FOUND", message: "לא נמצא" } }, { status: 404 });
  try {
    const stream = await store.getStream(p.k);
    const headers: Record<string, string> = {
      "content-type": p.ct ?? "application/octet-stream",
      "cache-control": "private, max-age=300",
    };
    if (p.fn) headers["content-disposition"] = contentDisposition(p.fn, p.inl);
    return new Response(Readable.toWeb(stream as Readable) as ReadableStream, { headers });
  } catch {
    return json({ error: { code: "NOT_FOUND", message: "הקובץ לא נמצא" } }, { status: 404 });
  }
}
