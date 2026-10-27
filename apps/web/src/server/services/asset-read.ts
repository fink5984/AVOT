import "server-only";
import { Readable } from "node:stream";
import { CATEGORY_SLUG, padLotNumber } from "@avot/shared";
import { db } from "../db";
import { notFound } from "../errors";
import { contentDisposition } from "../http";
import { storage } from "../storage";

/**
 * Serves a derivative or original of an asset the caller's organization owns.
 * Local driver: streamed through the app. S3 driver: 302 to a presigned URL
 * valid for 5 minutes. Object keys are never exposed as permanent URLs.
 */
export async function serveAsset(
  orgId: string,
  assetId: string,
  kind: "thumb" | "preview" | "original" | "processed",
  opts: { role?: "PRIMARY" | "RAW"; download?: boolean } = {},
): Promise<Response> {
  // deleted (recycle-bin) photos stay viewable so they can be inspected before restoring
  const asset = await db.photoAsset.findFirst({
    where: { id: assetId, organizationId: orgId },
    include: { files: true, item: { select: { inventoryNumber: true } } },
  });
  if (!asset) throw notFound("התמונה");

  let key: string | null = null;
  let contentType = "application/octet-stream";
  let filename: string | undefined;
  if (kind === "thumb") {
    key = asset.thumbKey;
    contentType = "image/webp";
  } else if (kind === "preview") {
    key = asset.previewKey;
    contentType = "image/jpeg";
  } else if (kind === "processed") {
    key = asset.processedKey;
    contentType = asset.processedMime ?? "image/jpeg";
    if (key) filename = `${asset.item.inventoryNumber}-${CATEGORY_SLUG[asset.category]}-${padLotNumber(asset.sequence)}.${key.split(".").pop()}`;
  } else {
    const file = asset.files.find((f) => f.role === (opts.role ?? "PRIMARY") && f.uploadStatus === "VERIFIED");
    if (file) {
      key = file.storageKey;
      contentType = file.mimeType;
      filename = `${asset.item.inventoryNumber}-${CATEGORY_SLUG[asset.category]}-${padLotNumber(asset.sequence)}.${file.extension}`;
    }
  }
  if (!key) throw notFound("הקובץ");

  const store = storage();
  if (store.driver === "s3") {
    const url = await store.readUrl(key, {
      contentType,
      filename: filename,
      inline: !opts.download,
      expiresInSeconds: 300,
    });
    return new Response(null, { status: 302, headers: { location: url, "cache-control": "private, max-age=240" } });
  }
  // a DB row whose file is absent from local storage (e.g. a DB shared with another machine) is a 404, not a 500
  const stream = await store.getStream(key).catch((err: NodeJS.ErrnoException) => {
    throw err.code === "ENOENT" ? notFound("הקובץ") : err;
  });
  const headers: Record<string, string> = {
    "content-type": contentType,
    "cache-control": kind === "original" || kind === "processed" ? "private, no-store" : "private, max-age=3600",
  };
  if (filename) headers["content-disposition"] = contentDisposition(filename, !opts.download);
  return new Response(Readable.toWeb(stream as Readable) as ReadableStream, { headers });
}
