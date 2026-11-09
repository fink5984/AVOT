import "server-only";
import sharp from "sharp";
import { createHash } from "node:crypto";
import type { PhotoCategory } from "@avot/shared";
import { db } from "../db";
import { storage } from "../storage";
import { he } from "@/i18n/he";
import type { AiConfig } from "./config";

/*
 * Image preparation for Vision. Read-only on storage: originals and processed files are never modified.
 *
 *  - every non-deleted photo of the physical item, in the gallery order (category, then the master order);
 *  - ONE source per shot, so the same photograph is never sent twice: the processed image (rotated, cropped) when it is
 *    finished, else the verified original, else the preview derivative. RAW files are never sent;
 *  - EXIF orientation, then the photo's own view rotation (the gallery shows it rotated the same way);
 *  - resized to BOOK_AI_IMAGE_MAX_EDGE, title pages to BOOK_AI_DETAIL_MAX_EDGE, plus zoomed top / bottom halves of the
 *    first title pages for small print and signatures (same shot, marked as a zoom - not a page). An item with no
 *    title-page photo (poster, letter, document) gets this for its first photo;
 *  - a photo that cannot be used is never dropped silently: it is listed in the report with the reason.
 */

const DISPLAYABLE = new Set(["image/jpeg", "image/png", "image/webp", "image/tiff"]);

export interface PreparedImage {
  /** stable id inside the run: img-01, img-01-top … */
  id: string;
  assetId: string;
  category: PhotoCategory;
  /** human label sent next to the image */
  label: string;
  /** id of the full image this is a zoom of */
  zoomOf: string | null;
  source: "processed" | "original" | "preview";
  data: Buffer;
  mime: "image/jpeg";
  width: number;
  height: number;
  /** OpenAI image detail level */
  detail: "high" | "auto";
}

export interface ImageReportEntry {
  assetId: string;
  imageId: string | null;
  category: PhotoCategory;
  sequence: number;
  status: "prepared" | "skipped";
  source?: PreparedImage["source"];
  reason?: string;
  zooms?: string[];
  bytes?: number;
  width?: number;
  height?: number;
}

export interface PreparedImages {
  images: PreparedImage[];
  report: ImageReportEntry[];
  /** identifies the set of photos (ids + versions) the run looked at: a change during the run is detected with it */
  fingerprint: string;
}

/** Fingerprint of the item's current photos (same rule as prepareImages, without reading any file). */
export async function photosFingerprint(itemId: string): Promise<string> {
  const assets = await db.photoAsset.findMany({
    where: { inventoryItemId: itemId, deletedAt: null },
    orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
    select: { id: true, updatedAt: true },
  });
  return fingerprintOf(assets);
}

function fingerprintOf(assets: { id: string; updatedAt: Date }[]): string {
  return createHash("sha1")
    .update(assets.map((a) => `${a.id}:${a.updatedAt.getTime()}`).join("|"))
    .digest("hex")
    .slice(0, 16);
}

async function encode(img: sharp.Sharp, longEdge: number, quality: number) {
  const { data, info } = await img
    .resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * One shot → the Vision versions: EXIF orientation, then the photo's own view rotation (multiples of 90), resized;
 * with `zoom`, overlapping top / bottom halves at the detail size (a line on the middle is whole in at least one).
 */
export async function prepareShot(buffer: Buffer, o: { rotation: number; detail: boolean; zoom: boolean }, cfg: AiConfig) {
  const oriented = await sharp(buffer, { failOn: "error" }).rotate().toBuffer();
  const rotated = o.rotation ? await sharp(oriented).rotate(o.rotation).toBuffer() : oriented;
  const full = await encode(sharp(rotated), o.detail ? cfg.BOOK_AI_DETAIL_MAX_EDGE : cfg.BOOK_AI_IMAGE_MAX_EDGE, cfg.BOOK_AI_JPEG_QUALITY);
  const zooms: { suffix: "top" | "bottom"; name: string; data: Buffer; width: number; height: number }[] = [];
  if (o.zoom) {
    const meta = await sharp(rotated).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w >= 600 && h >= 600) {
      const half = Math.round(h * 0.55);
      for (const [suffix, top, name] of [["top", 0, "חלק עליון"], ["bottom", h - half, "חלק תחתון"]] as const) {
        zooms.push({ suffix, name, ...(await encode(sharp(rotated).extract({ left: 0, top, width: w, height: half }), cfg.BOOK_AI_DETAIL_MAX_EDGE, cfg.BOOK_AI_JPEG_QUALITY)) });
      }
    }
  }
  return { full, zooms };
}

/**
 * `manuscript`: the item is (or turned out to be) a manuscript, a handwritten letter or a document. Then every one of the
 * first BOOK_AI_MANUSCRIPT_ZOOM_PAGES photos gets the detail size and zoomed top / bottom halves (small handwriting,
 * signatures, dates), not only the title page. Same photos, same ids, same order: only more resolution on the text.
 */
export async function prepareImages(orgId: string, itemId: string, cfg: AiConfig, opts: { manuscript?: boolean } = {}): Promise<PreparedImages> {
  const assets = await db.photoAsset.findMany({
    where: { organizationId: orgId, inventoryItemId: itemId, deletedAt: null },
    orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
    include: { files: true },
  });
  const store = storage();
  const images: PreparedImage[] = [];
  const report: ImageReportEntry[] = [];
  const perCategory = new Map<PhotoCategory, number>();
  const totals = new Map<PhotoCategory, number>();
  for (const a of assets) totals.set(a.category, (totals.get(a.category) ?? 0) + 1);
  const hasTitlePage = totals.has("TITLE_PAGE");
  let n = 0;
  let titleZooms = 0;
  let manuscriptZooms = 0;

  for (const a of assets) {
    const index = (perCategory.get(a.category) ?? 0) + 1;
    perCategory.set(a.category, index);
    const base = { assetId: a.id, category: a.category, sequence: a.sequence };
    const primary = a.files.find((f) => f.role === "PRIMARY" && f.uploadStatus === "VERIFIED" && DISPLAYABLE.has(f.mimeType));
    const candidates: { source: PreparedImage["source"]; key: string }[] = [];
    if ((a.imageState === "DONE" || a.imageState === "NEEDS_REVIEW") && a.processedKey) candidates.push({ source: "processed", key: a.processedKey });
    if (primary) candidates.push({ source: "original", key: primary.storageKey });
    if (a.previewKey) candidates.push({ source: "preview", key: a.previewKey });
    if (!candidates.length) {
      const pending = a.files.some((f) => f.role === "PRIMARY" && f.uploadStatus !== "VERIFIED");
      report.push({ ...base, imageId: null, status: "skipped", reason: pending ? "הקובץ עדיין לא הועלה ואומת" : "אין קובץ תמונה שניתן להציג (למשל RAW בלבד)" });
      continue;
    }

    let done = false;
    let lastProblem = "";
    // a missing or unreadable file falls back to the next source of the SAME shot (never to a second copy)
    for (const c of candidates) {
      let buffer: Buffer;
      try {
        buffer = await store.getBuffer(c.key);
      } catch (err) {
        lastProblem = (err as NodeJS.ErrnoException).code === "ENOENT" ? "הקובץ חסר באחסון" : "שגיאה בקריאת הקובץ מהאחסון";
        continue;
      }
      try {
        // without a title-page photo (a poster, letter, document) the first photo is the main page: same detail and zoom
        const isTitle = hasTitlePage ? a.category === "TITLE_PAGE" : n === 0;
        const msPage = !!opts.manuscript && manuscriptZooms < cfg.BOOK_AI_MANUSCRIPT_ZOOM_PAGES;
        const detail = isTitle || msPage;
        const zoom = (isTitle && titleZooms < cfg.BOOK_AI_TITLE_ZOOM_PAGES) || msPage;
        const shot = await prepareShot(buffer, { rotation: a.rotation, detail, zoom }, cfg);
        if (isTitle && zoom) titleZooms++;
        if (msPage) manuscriptZooms++;
        const id = `img-${String(++n).padStart(2, "0")}`;
        const label = `${id} · ${he.category[a.category]} · ${index}/${totals.get(a.category)}`;
        const { full } = shot;
        images.push({ id, assetId: a.id, category: a.category, label, zoomOf: null, source: c.source, data: full.data, mime: "image/jpeg", width: full.width, height: full.height, detail: detail ? "high" : "auto" });
        const zooms: string[] = [];
        for (const z of shot.zooms) {
          const zid = `${id}-${z.suffix}`;
          zooms.push(zid);
          images.push({ id: zid, assetId: a.id, category: a.category, label: `${zid} · הגדלה של ${id} (${z.name})`, zoomOf: id, source: c.source, data: z.data, mime: "image/jpeg", width: z.width, height: z.height, detail: "high" });
        }
        report.push({ ...base, imageId: id, status: "prepared", source: c.source, zooms: zooms.length ? zooms : undefined, bytes: full.data.length, width: full.width, height: full.height });
        done = true;
        break;
      } catch {
        lastProblem = "קובץ התמונה פגום או בפורמט שאינו נתמך";
      }
    }
    if (!done) report.push({ ...base, imageId: null, status: "skipped", reason: lastProblem || "לא ניתן להכין את התמונה" });
  }
  return { images, report, fingerprint: fingerprintOf(assets) };
}

/** Splits images into requests within the image-count and byte limits; a zoom always travels with its full image. */
export function batchImages(images: PreparedImage[], maxImages: number, maxBytes: number): PreparedImage[][] {
  const groups: PreparedImage[][] = [];
  for (const img of images) {
    if (img.zoomOf && groups.length && groups[groups.length - 1]!.some((g) => g.id === img.zoomOf)) groups[groups.length - 1]!.push(img);
    else groups.push([img]);
  }
  const batches: PreparedImage[][] = [];
  let cur: PreparedImage[] = [];
  let bytes = 0;
  for (const g of groups) {
    const gb = g.reduce((s, i) => s + i.data.length, 0);
    if (cur.length && (cur.length + g.length > maxImages || bytes + gb > maxBytes)) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(...g);
    bytes += gb;
  }
  if (cur.length) batches.push(cur);
  return batches;
}
