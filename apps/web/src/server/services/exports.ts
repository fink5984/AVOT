import "server-only";
import { PassThrough } from "node:stream";
import archiver from "archiver";
import sharp from "sharp";
import { z } from "zod";
import { CATEGORY_SLUG, PHOTO_CATEGORIES, padLotNumber, type PhotoCategory } from "@avot/shared";
import type { Job } from "@prisma/client";
import { db } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { UserPrincipal } from "../auth/principal";
import { assertHouse } from "../auth/houses";
import { INVENTORY_CATALOG_NUMBER } from "./capture-context";
import { keys, storage } from "../storage";
import { log } from "../log";
import { safeSegment, uniqueName } from "./filenames";
import { activeLotOfItem, memberItemIds } from "./lot-members";

export const exportRequestSchema = z.object({
  scope: z.enum(["category", "lot", "catalog", "selection", "item"]),
  catalogId: z.string().uuid().optional(),
  lotId: z.string().uuid().optional(),
  /** scope "item": the inventory book (folders named by inventory number) */
  inventoryItemId: z.string().uuid().optional(),
  category: z.enum(PHOTO_CATEGORIES).optional(),
  assetIds: z.array(z.string().uuid()).max(5000).optional(),
  /** original = files as shot; processed = the cropped / background-removed image where one exists; catalog-jpeg = resized JPEG (from the processed image where one exists) */
  variant: z.enum(["original", "processed", "catalog-jpeg"]).default("original"),
  /** long edge in px for catalog-jpeg */
  maxSize: z.number().int().min(400).max(12000).default(3000),
  includeRaw: z.boolean().default(true),
  readableFolders: z.boolean().default(false),
});
export type ExportRequest = z.infer<typeof exportRequestSchema>;

const EXPORT_TTL_HOURS = 48;

export async function requestExport(user: UserPrincipal, request: ExportRequest) {
  let input = request;
  // resolve to a catalog for scoping and naming; verifies organization ownership and house access
  let catalogId = input.catalogId;
  let itemId = input.inventoryItemId ?? null;
  if (input.lotId) {
    const lot = await db.lot.findFirst({ where: { id: input.lotId, organizationId: user.organizationId } });
    if (lot) {
      catalogId = lot.catalogId;
      itemId = lot.inventoryItemId;
    } else {
      // the book screen sends its inventory id where a lot id used to be
      const item = await db.inventoryItem.findFirst({ where: { id: input.lotId, organizationId: user.organizationId } });
      if (!item) throw notFound("הפריט");
      itemId = item.id;
      input = { ...input, lotId: undefined, inventoryItemId: item.id, scope: input.scope === "lot" ? "item" : input.scope };
    }
  }
  if (input.scope === "selection") {
    if (!input.assetIds?.length) throw new AppError("VALIDATION", "לא נבחרו תמונות");
    const count = await db.photoAsset.count({ where: { id: { in: input.assetIds }, organizationId: user.organizationId, deletedAt: null } });
    if (count !== new Set(input.assetIds).size) throw notFound("חלק מהתמונות");
  }
  if (catalogId) {
    const c = await db.catalog.findFirst({ where: { id: catalogId, organizationId: user.organizationId } });
    if (!c) throw notFound("הקטלוג");
    assertHouse(user, c.auctionHouseId);
  }
  if (input.scope === "item") {
    if (!input.inventoryItemId) throw new AppError("VALIDATION", "חסר ספר");
    const item = await db.inventoryItem.findFirst({ where: { id: input.inventoryItemId, organizationId: user.organizationId } });
    if (!item) throw notFound("הספר");
  }
  if (input.scope === "lot" && !input.lotId) throw new AppError("VALIDATION", "חסר פריט");
  if (input.scope === "category" && !input.lotId && !input.inventoryItemId) throw new AppError("VALIDATION", "חסר פריט");
  if (input.scope === "category" && !input.category) throw new AppError("VALIDATION", "חסרה קטגוריה");
  if (input.scope === "catalog" && !catalogId) throw new AppError("VALIDATION", "חסר קטלוג");

  const job = await db.job.create({
    data: {
      organizationId: user.organizationId,
      type: "EXPORT_ZIP",
      payload: { ...input, catalogId },
      createdById: user.userId,
    },
  });
  await audit(user, { action: "export.requested", entityType: "export", entityId: job.id, lotId: input.lotId, inventoryItemId: itemId, data: input as object });
  return job;
}

interface ExportRow {
  assetId: string;
  catalogNumber: string;
  catalogName: string;
  lotNumber: number;
  lotTitle: string;
  inventoryNumber: string;
  category: PhotoCategory;
  index: number;
  displayName: string | null;
  capturedAt: Date;
  createdBy: string | null;
  width: number | null;
  height: number | null;
  files: { role: string; storageKey: string; extension: string; sha256: string; sizeBytes: bigint; mimeType: string }[];
  processed: { key: string; ext: string } | null;
  /** photo of a combined lot: `index` is the position in the lot's shared gallery (all books), files are named by it */
  combined?: boolean;
}

interface BookContext {
  itemId: string;
  inventoryNumber: string;
  catalogNumber: string;
  catalogName: string;
  lotNumber: number;
  title: string;
  /** set → apply that lot's presentation (hidden photos, order) */
  lotId: string | null;
  /** a combined lot: every book of the lot, in the lot's order (itemId is only the first of them) */
  itemIds?: string[];
}

const exportAssetInclude = { createdBy: { select: { name: true } }, files: { where: { uploadStatus: "VERIFIED" as const } } };

/**
 * Photos belong to books; a catalog export walks the catalog's lots and takes
 * each lot's book photos in that lot's presentation order (hidden ones left
 * out). Folder names keep the catalog/lot numbering of the previous version.
 */
async function collect(orgId: string, p: ExportRequest): Promise<ExportRow[]> {
  let books: BookContext[] = [];
  let only: Set<string> | null = null;
  const lotCtx = async (l: { id: string; lotNumber: number; title: string; inventoryItemId: string; item: { inventoryNumber: string }; catalog: { number: string; name: string } }): Promise<BookContext> => {
    const ids = await memberItemIds(l.id);
    return {
      itemId: l.inventoryItemId,
      inventoryNumber: l.item.inventoryNumber,
      catalogNumber: l.catalog.number,
      catalogName: l.catalog.name,
      lotNumber: l.lotNumber,
      title: l.title,
      lotId: l.id,
      ...(ids.length > 1 ? { itemIds: ids } : {}),
    };
  };
  const lotInclude = { item: { select: { inventoryNumber: true } }, catalog: { select: { number: true, name: true } } } as const;

  if ((p.scope === "lot" || p.scope === "category") && p.lotId) {
    const lot = await db.lot.findFirst({ where: { id: p.lotId, organizationId: orgId }, include: lotInclude });
    if (lot) books = [await lotCtx(lot)];
  } else if (p.scope === "catalog") {
    // lots merged into another lot are history: their books are exported with the combined lot
    const lots = await db.lot.findMany({ where: { catalogId: p.catalogId!, organizationId: orgId, mergedIntoLotId: null }, include: lotInclude, orderBy: { lotNumber: "asc" } });
    books = await Promise.all(lots.map(lotCtx));
  } else if (p.scope === "item" || p.scope === "category") {
    const item = await db.inventoryItem.findFirst({ where: { id: p.inventoryItemId!, organizationId: orgId } });
    if (item) books = [{ itemId: item.id, inventoryNumber: item.inventoryNumber, catalogNumber: INVENTORY_CATALOG_NUMBER, catalogName: "מלאי", lotNumber: Number(item.serial), title: item.title, lotId: null }];
  } else {
    only = new Set(p.assetIds!);
    const picked = await db.photoAsset.findMany({
      where: { id: { in: p.assetIds! }, organizationId: orgId, deletedAt: null },
      select: { inventoryItemId: true, lot: { include: lotInclude }, item: { select: { inventoryNumber: true, serial: true, title: true } } },
    });
    const seen = new Set<string>();
    for (const a of picked) {
      if (seen.has(a.inventoryItemId)) continue;
      seen.add(a.inventoryItemId);
      // the book's catalog lot: the one the photo was shot for, else the book's active lot (ordinary or combined)
      const active = a.lot ?? (await activeLotOfItem(a.inventoryItemId).then((l) => (l ? db.lot.findUnique({ where: { id: l.id }, include: lotInclude }) : null)));
      if (active) {
        const ctx = await lotCtx(active);
        // a combined lot is exported as one unit in the order of its shared gallery
        books.push(ctx.itemIds ? ctx : { ...ctx, lotId: null });
      } else {
        books.push({ itemId: a.inventoryItemId, inventoryNumber: a.item.inventoryNumber, catalogNumber: INVENTORY_CATALOG_NUMBER, catalogName: "מלאי", lotNumber: Number(a.item.serial), title: a.item.title, lotId: null });
      }
    }
    // two selected photos of different books of one combined lot: one lot entry
    books = books.filter((b, i) => !b.itemIds || books.findIndex((x) => x.lotId === b.lotId) === i);
  }
  if (!books.length) return [];

  const allItemIds = [...new Set(books.flatMap((b) => b.itemIds ?? [b.itemId]))];
  const [assets, display, itemRows] = await Promise.all([
    db.photoAsset.findMany({
      where: { organizationId: orgId, inventoryItemId: { in: allItemIds }, deletedAt: null, ...(p.scope === "category" ? { category: p.category! } : {}) },
      include: exportAssetInclude,
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
    }),
    db.lotDisplayAsset.findMany({ where: { lotId: { in: books.map((b) => b.lotId).filter((x): x is string => !!x) } } }),
    db.inventoryItem.findMany({ where: { id: { in: allItemIds } }, select: { id: true, inventoryNumber: true } }),
  ]);
  const numberOf = new Map(itemRows.map((i) => [i.id, i.inventoryNumber]));

  const rows: ExportRow[] = [];
  const toRow = (a: (typeof assets)[number], b: BookContext, category: PhotoCategory, index: number, combined: boolean): ExportRow => ({
    assetId: a.id,
    catalogNumber: b.catalogNumber,
    catalogName: b.catalogName,
    lotNumber: b.lotNumber,
    lotTitle: b.title,
    inventoryNumber: numberOf.get(a.inventoryItemId) ?? b.inventoryNumber,
    category,
    index,
    displayName: a.displayName,
    capturedAt: a.capturedAt,
    createdBy: a.createdBy?.name ?? null,
    width: a.width,
    height: a.height,
    files: a.files,
    // only the finished full-resolution file counts: while the photo is queued / preview-only / failed the key may be an older version
    processed: a.processedKey && (a.imageState === "DONE" || a.imageState === "NEEDS_REVIEW") ? { key: a.processedKey, ext: a.processedKey.split(".").pop() ?? "jpg" } : null,
    ...(combined ? { combined: true } : {}),
  });
  for (const b of books) {
    const shown = display.filter((d) => d.lotId === b.lotId);
    const byId = new Map(shown.map((d) => [d.assetId, d]));
    if (b.itemIds) {
      // combined lot: ONE sequence over all the books' visible photos, in the lot's gallery order
      const bookIdx = new Map(b.itemIds.map((id, i) => [id, i]));
      const catIdx = new Map(PHOTO_CATEGORIES.map((c, i) => [c, i]));
      const explicit = (a: (typeof assets)[number]) => byId.get(a.id)?.sortOrder ?? Number.POSITIVE_INFINITY;
      const list = assets
        .filter((a) => bookIdx.has(a.inventoryItemId) && a.files.length > 0 && !byId.get(a.id)?.hidden && (!only || only.has(a.id)))
        .sort((x, y) => explicit(x) - explicit(y) || bookIdx.get(x.inventoryItemId)! - bookIdx.get(y.inventoryItemId)! || catIdx.get(x.category)! - catIdx.get(y.category)! || x.sortOrder - y.sortOrder);
      list.forEach((a, i) => rows.push(toRow(a, b, a.category, i + 1, true)));
      continue;
    }
    const key = (a: (typeof assets)[number]) => byId.get(a.id)?.sortOrder ?? 1_000_000 + a.sortOrder;
    for (const category of PHOTO_CATEGORIES) {
      const list = assets
        .filter((a) => a.inventoryItemId === b.itemId && a.category === category && a.files.length > 0 && !byId.get(a.id)?.hidden && (!only || only.has(a.id)))
        .sort((x, y) => key(x) - key(y));
      list.forEach((a, i) => rows.push(toRow(a, b, category, i + 1, false)));
    }
  }
  return rows;
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Runs an EXPORT_ZIP job: streams a ZIP straight into object storage. */
export async function runExportJob(job: Job): Promise<void> {
  const p = exportRequestSchema.parse(job.payload);
  const rows = await collect(job.organizationId, p);
  if (!rows.length) throw new Error("אין תמונות מאומתות לייצוא בטווח שנבחר");
  await db.job.update({ where: { id: job.id }, data: { progressTotal: rows.length, progress: 0 } });

  const store = storage();
  const zip = archiver("zip", { zlib: { level: 0 }, forceZip64: true });
  const out = new PassThrough();
  zip.pipe(out);
  const resultKey = keys.export(job.organizationId, job.id);
  const uploading = store.putStream(resultKey, out, "application/zip");
  const zipError = new Promise<never>((_, reject) => zip.on("error", reject));

  // append one entry and wait until archiver consumed it — keeps memory and open
  // file handles bounded for catalog-sized exports
  const appendAndWait = (source: Buffer | NodeJS.ReadableStream, name: string, date: Date) =>
    new Promise<void>((resolve) => {
      const onEntry = (entry: { name: string }) => {
        if (entry.name === name) {
          zip.off("entry", onEntry);
          resolve();
        }
      };
      zip.on("entry", onEntry);
      zip.append(source as Buffer, { name, date });
    });

  const first = rows[0]!;
  const catalogFolder = `Catalog-${safeSegment(first.catalogNumber.padStart(3, "0"), 20)}`;
  const lotFolders = new Map<number, string>();
  const usedLotFolders = new Set<string>();
  const manifest: Record<string, unknown>[] = [];
  /** processed ZIP: photos that had no finished processed file — their original is included, named and listed as such */
  const withoutProcessed: string[] = [];

  const work = (async () => {
    let done = 0;
    for (const r of rows) {
      let lotFolder = lotFolders.get(r.lotNumber);
      if (!lotFolder) {
        const base = `Lot-${padLotNumber(r.lotNumber)}`;
        lotFolder = uniqueName(p.readableFolders ? `${base} ${safeSegment(r.lotTitle, 50)}` : base, usedLotFolders);
        lotFolders.set(r.lotNumber, lotFolder);
      }
      const slug = CATEGORY_SLUG[r.category];
      // a combined lot: one folder, files numbered in the lot's gallery order and named by the book they belong to
      const stem = r.combined ? `L${padLotNumber(r.lotNumber)}-${padLotNumber(r.index)}-${safeSegment(r.inventoryNumber, 30)}-${slug}` : `L${padLotNumber(r.lotNumber)}-${slug}-${padLotNumber(r.index)}`;
      const dir = r.combined ? `${catalogFolder}/${lotFolder}` : `${catalogFolder}/${lotFolder}/${slug}`;
      const entryFiles: string[] = [];
      let version = p.variant === "catalog-jpeg" ? "catalog-jpeg" : p.variant;
      for (const f of r.files) {
        if (f.role === "RAW" && !p.includeRaw) continue;
        if (p.variant === "processed" && f.role === "PRIMARY" && r.processed) {
          const name = `${dir}/${stem}.${r.processed.ext}`;
          await appendAndWait(await store.getStream(r.processed.key), name, r.capturedAt);
          entryFiles.push(name);
        } else if (p.variant === "catalog-jpeg") {
          if (f.role !== "PRIMARY") continue;
          const buf = await store.getBuffer(r.processed ? r.processed.key : f.storageKey);
          const jpeg = await sharp(buf)
            .rotate()
            .flatten({ background: "#ffffff" })
            .resize({ width: p.maxSize, height: p.maxSize, fit: "inside", withoutEnlargement: true })
            .keepIccProfile()
            .jpeg({ quality: 90, mozjpeg: true })
            .toBuffer();
          const name = `${dir}/${stem}.jpg`;
          await appendAndWait(jpeg, name, r.capturedAt);
          entryFiles.push(name);
        } else {
          // never present an original as a processed image: in a processed export it is marked in the file name and in the report
          const missing = p.variant === "processed" && f.role === "PRIMARY";
          const name = `${dir}/${stem}${missing ? "-ORIGINAL-NOT-PROCESSED" : ""}.${f.extension}`;
          await appendAndWait(await store.getStream(f.storageKey), name, r.capturedAt);
          entryFiles.push(name);
          if (missing) {
            version = "original (no processed file)";
            withoutProcessed.push(name);
          }
        }
      }
      manifest.push({
        file: entryFiles.join(" | "),
        catalog_number: r.catalogNumber,
        catalog_name: r.catalogName,
        lot_number: r.lotNumber,
        lot_title: r.lotTitle,
        inventory_number: r.inventoryNumber,
        category: r.category,
        order: r.index,
        display_name: r.displayName ?? "",
        width: r.width ?? "",
        height: r.height ?? "",
        captured_at: r.capturedAt.toISOString(),
        captured_by: r.createdBy ?? "",
        sha256_original: r.files.map((f) => `${f.role}:${f.sha256}`).join(" | "),
        version,
        asset_id: r.assetId,
      });
      done++;
      if (done % 5 === 0 || done === rows.length) await db.job.update({ where: { id: job.id }, data: { progress: done } });
    }
    const headers = Object.keys(manifest[0] ?? {});
    const csv = "﻿" + [headers.join(","), ...manifest.map((m) => headers.map((h) => csvCell(m[h])).join(","))].join("\r\n");
    zip.append(csv, { name: `${catalogFolder}/manifest.csv` });
    if (withoutProcessed.length) {
      zip.append(
        ["These photos have no finished processed image (queued, failed or never processed).", "Their ORIGINAL is included instead, marked ORIGINAL-NOT-PROCESSED in the file name.", "", ...withoutProcessed].join("\r\n"),
        { name: `${catalogFolder}/NOT-PROCESSED.txt` },
      );
    }
    zip.append(JSON.stringify({ generatedAt: new Date().toISOString(), variant: p.variant, withoutProcessedFile: withoutProcessed.length, items: manifest }, null, 2), {
      name: `${catalogFolder}/manifest.json`,
    });
    await zip.finalize();
  })();

  const [, put] = await Promise.race([Promise.all([work, uploading]), zipError]);
  const lotPart = p.lotId && rows.every((r) => r.lotNumber === first.lotNumber) ? `-Lot-${padLotNumber(first.lotNumber)}` : "";
  const catPart = p.scope === "category" && p.category ? `-${CATEGORY_SLUG[p.category]}` : "";
  await db.job.update({
    where: { id: job.id },
    data: {
      resultKey,
      resultName: `${catalogFolder}${lotPart}${catPart}.zip`,
      resultBytes: BigInt(put.sizeBytes),
      expiresAt: new Date(Date.now() + EXPORT_TTL_HOURS * 3600 * 1000),
    },
  });
  log.info("export finished", { jobId: job.id, files: rows.length, bytes: put.sizeBytes });
}

/** CSV export of lot metadata (not photos), synchronous — small payload. A combined lot is ONE row with ONE lot number. */
export async function lotsCsv(orgId: string, catalogId: string): Promise<{ filename: string; body: string }> {
  const catalog = await db.catalog.findFirst({ where: { id: catalogId, organizationId: orgId } });
  if (!catalog) throw notFound("הקטלוג");
  const lots = await db.lot.findMany({
    where: { catalogId, mergedIntoLotId: null },
    orderBy: { lotNumber: "asc" },
    include: { item: { select: { inventoryNumber: true } }, members: { where: { removedAt: null }, orderBy: { sortOrder: "asc" }, select: { inventoryItemId: true, item: { select: { inventoryNumber: true, title: true } } } } },
  });
  const itemIdsOf = (l: (typeof lots)[number]) => (l.members.length ? l.members.map((m) => m.inventoryItemId) : [l.inventoryItemId]);
  const counts = await db.photoAsset.groupBy({ by: ["inventoryItemId", "category"], where: { inventoryItemId: { in: lots.flatMap(itemIdsOf) }, deletedAt: null }, _count: { _all: true } });
  const header = ["lot_number", "inventory_number", "book_count", "title", "subtitle", "author", "print_year", "print_place", "short_description", "status", "commercial_status", "assignment", ...PHOTO_CATEGORIES.map((c) => `photos_${CATEGORY_SLUG[c]}`), "photos_total", "updated_at"];
  const lines = lots.map((l) => {
    const ids = itemIdsOf(l);
    const per = PHOTO_CATEGORIES.map((c) => counts.filter((x) => ids.includes(x.inventoryItemId) && x.category === c).reduce((n, x) => n + x._count._all, 0));
    const numbers = l.members.length > 1 ? l.members.map((m) => m.item.inventoryNumber).join(" | ") : l.item.inventoryNumber;
    return [l.lotNumber, numbers, Math.max(1, l.members.length), l.title, l.subtitle, l.author, l.printYear, l.printPlace, l.shortDescription, l.status, l.commercialStatus, l.assignmentStatus, ...per, per.reduce((a, b) => a + b, 0), l.updatedAt.toISOString()]
      .map(csvCell)
      .join(",");
  });
  return { filename: `Catalog-${safeSegment(catalog.number)}-lots.csv`, body: "﻿" + [header.join(","), ...lines].join("\r\n") };
}
