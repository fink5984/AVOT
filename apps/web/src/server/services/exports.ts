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

export const exportRequestSchema = z.object({
  scope: z.enum(["category", "lot", "catalog", "selection", "item"]),
  catalogId: z.string().uuid().optional(),
  lotId: z.string().uuid().optional(),
  /** scope "item": the inventory book (folders named by inventory number) */
  inventoryItemId: z.string().uuid().optional(),
  category: z.enum(PHOTO_CATEGORIES).optional(),
  assetIds: z.array(z.string().uuid()).max(5000).optional(),
  variant: z.enum(["original", "catalog-jpeg"]).default("original"),
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
  const lotCtx = (l: { id: string; lotNumber: number; title: string; inventoryItemId: string; item: { inventoryNumber: string }; catalog: { number: string; name: string } }) => ({
    itemId: l.inventoryItemId,
    inventoryNumber: l.item.inventoryNumber,
    catalogNumber: l.catalog.number,
    catalogName: l.catalog.name,
    lotNumber: l.lotNumber,
    title: l.title,
    lotId: l.id,
  });
  const lotInclude = { item: { select: { inventoryNumber: true } }, catalog: { select: { number: true, name: true } } } as const;

  if ((p.scope === "lot" || p.scope === "category") && p.lotId) {
    const lot = await db.lot.findFirst({ where: { id: p.lotId, organizationId: orgId }, include: lotInclude });
    if (lot) books = [lotCtx(lot)];
  } else if (p.scope === "catalog") {
    const lots = await db.lot.findMany({ where: { catalogId: p.catalogId!, organizationId: orgId }, include: lotInclude, orderBy: { lotNumber: "asc" } });
    books = lots.map(lotCtx);
  } else if (p.scope === "item" || p.scope === "category") {
    const item = await db.inventoryItem.findFirst({ where: { id: p.inventoryItemId!, organizationId: orgId } });
    if (item) books = [{ itemId: item.id, inventoryNumber: item.inventoryNumber, catalogNumber: INVENTORY_CATALOG_NUMBER, catalogName: "מלאי", lotNumber: item.serial, title: item.title, lotId: null }];
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
      const active = a.lot ?? (await db.lot.findFirst({ where: { inventoryItemId: a.inventoryItemId, assignmentStatus: "ACTIVE" }, include: lotInclude }));
      books.push(
        active
          ? { ...lotCtx(active), lotId: null }
          : { itemId: a.inventoryItemId, inventoryNumber: a.item.inventoryNumber, catalogNumber: INVENTORY_CATALOG_NUMBER, catalogName: "מלאי", lotNumber: a.item.serial, title: a.item.title, lotId: null },
      );
    }
  }
  if (!books.length) return [];

  const [assets, display] = await Promise.all([
    db.photoAsset.findMany({
      where: { organizationId: orgId, inventoryItemId: { in: books.map((b) => b.itemId) }, deletedAt: null, ...(p.scope === "category" ? { category: p.category! } : {}) },
      include: exportAssetInclude,
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
    }),
    db.lotDisplayAsset.findMany({ where: { lotId: { in: books.map((b) => b.lotId).filter((x): x is string => !!x) } } }),
  ]);

  const rows: ExportRow[] = [];
  for (const b of books) {
    const shown = display.filter((d) => d.lotId === b.lotId);
    const byId = new Map(shown.map((d) => [d.assetId, d]));
    const key = (a: (typeof assets)[number]) => byId.get(a.id)?.sortOrder ?? 1_000_000 + a.sortOrder;
    for (const category of PHOTO_CATEGORIES) {
      const list = assets
        .filter((a) => a.inventoryItemId === b.itemId && a.category === category && a.files.length > 0 && !byId.get(a.id)?.hidden && (!only || only.has(a.id)))
        .sort((x, y) => key(x) - key(y));
      list.forEach((a, i) =>
        rows.push({
          assetId: a.id,
          catalogNumber: b.catalogNumber,
          catalogName: b.catalogName,
          lotNumber: b.lotNumber,
          lotTitle: b.title,
          inventoryNumber: b.inventoryNumber,
          category,
          index: i + 1,
          displayName: a.displayName,
          capturedAt: a.capturedAt,
          createdBy: a.createdBy?.name ?? null,
          width: a.width,
          height: a.height,
          files: a.files,
        }),
      );
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
      const stem = `L${padLotNumber(r.lotNumber)}-${slug}-${padLotNumber(r.index)}`;
      const dir = `${catalogFolder}/${lotFolder}/${slug}`;
      const entryFiles: string[] = [];
      for (const f of r.files) {
        if (f.role === "RAW" && !p.includeRaw) continue;
        if (p.variant === "catalog-jpeg") {
          if (f.role !== "PRIMARY") continue;
          const buf = await store.getBuffer(f.storageKey);
          const jpeg = await sharp(buf)
            .rotate()
            .resize({ width: p.maxSize, height: p.maxSize, fit: "inside", withoutEnlargement: true })
            .keepIccProfile()
            .jpeg({ quality: 90, mozjpeg: true })
            .toBuffer();
          const name = `${dir}/${stem}.jpg`;
          await appendAndWait(jpeg, name, r.capturedAt);
          entryFiles.push(name);
        } else {
          const name = `${dir}/${stem}.${f.extension}`;
          await appendAndWait(await store.getStream(f.storageKey), name, r.capturedAt);
          entryFiles.push(name);
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
        asset_id: r.assetId,
      });
      done++;
      if (done % 5 === 0 || done === rows.length) await db.job.update({ where: { id: job.id }, data: { progress: done } });
    }
    const headers = Object.keys(manifest[0] ?? {});
    const csv = "﻿" + [headers.join(","), ...manifest.map((m) => headers.map((h) => csvCell(m[h])).join(","))].join("\r\n");
    zip.append(csv, { name: `${catalogFolder}/manifest.csv` });
    zip.append(JSON.stringify({ generatedAt: new Date().toISOString(), variant: p.variant, items: manifest }, null, 2), {
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

/** CSV export of lot metadata (not photos), synchronous — small payload. */
export async function lotsCsv(orgId: string, catalogId: string): Promise<{ filename: string; body: string }> {
  const catalog = await db.catalog.findFirst({ where: { id: catalogId, organizationId: orgId } });
  if (!catalog) throw notFound("הקטלוג");
  const lots = await db.lot.findMany({ where: { catalogId }, orderBy: { lotNumber: "asc" }, include: { item: { select: { inventoryNumber: true } } } });
  const counts = await db.photoAsset.groupBy({ by: ["inventoryItemId", "category"], where: { inventoryItemId: { in: lots.map((l) => l.inventoryItemId) }, deletedAt: null }, _count: { _all: true } });
  const header = ["lot_number", "inventory_number", "title", "subtitle", "author", "print_year", "print_place", "short_description", "status", "commercial_status", "assignment", ...PHOTO_CATEGORIES.map((c) => `photos_${CATEGORY_SLUG[c]}`), "photos_total", "updated_at"];
  const lines = lots.map((l) => {
    const per = PHOTO_CATEGORIES.map((c) => counts.find((x) => x.inventoryItemId === l.inventoryItemId && x.category === c)?._count._all ?? 0);
    return [l.lotNumber, l.item.inventoryNumber, l.title, l.subtitle, l.author, l.printYear, l.printPlace, l.shortDescription, l.status, l.commercialStatus, l.assignmentStatus, ...per, per.reduce((a, b) => a + b, 0), l.updatedAt.toISOString()]
      .map(csvCell)
      .join(",");
  });
  return { filename: `Catalog-${safeSegment(catalog.number)}-lots.csv`, body: "﻿" + [header.join(","), ...lines].join("\r\n") };
}
