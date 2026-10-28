/**
 * Load-test data: 10 catalogs × 100 lots × 20–50 photos (≈35,000 photo rows).
 * Clearly labelled ("בדיקת עומסים") and never mixed with real catalogs;
 * originals are NOT written (only one shared thumbnail), so the data exercises
 * list/gallery/report performance, not storage.
 *
 *   npm run seed:perf            # create
 *   npm run seed:perf -- --purge # remove all load-test catalogs
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { PrismaClient, type Prisma } from "@prisma/client";
import sharp from "sharp";

const db = new PrismaClient();
const PREFIX = "LOAD-";
const CATEGORIES = ["COVER", "TITLE_PAGE", "INTERIOR", "EXTERIOR"] as const;

async function purge() {
  const catalogs = await db.catalog.findMany({ where: { number: { startsWith: PREFIX } }, select: { id: true } });
  for (const c of catalogs) {
    const lots = await db.lot.findMany({ where: { catalogId: c.id }, select: { inventoryItemId: true } });
    const itemIds = lots.map((l) => l.inventoryItemId);
    const assets = await db.photoAsset.findMany({ where: { inventoryItemId: { in: itemIds } }, select: { id: true } });
    for (let i = 0; i < assets.length; i += 5000) {
      const ids = assets.slice(i, i + 5000).map((a) => a.id);
      await db.photoFile.deleteMany({ where: { assetId: { in: ids } } });
      await db.photoAsset.deleteMany({ where: { id: { in: ids } } });
    }
    await db.lotDescriptionVersion.deleteMany({ where: { lot: { catalogId: c.id } } });
    await db.lot.deleteMany({ where: { catalogId: c.id } });
    await db.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
    await db.catalog.delete({ where: { id: c.id } });
  }
  console.log(`removed ${catalogs.length} load-test catalogs`);
}

async function seed() {
  const org = await db.organization.findFirst();
  const user = await db.user.findFirst({ where: { role: "ADMIN" } });
  if (!org || !user) throw new Error("run create-admin first");
  const house = await db.auctionHouse.findFirst({ where: { organizationId: org.id, slug: "avot" } });
  if (!house) throw new Error("auction house 'avot' missing — run the migrations");

  // one shared thumbnail object for every seeded photo
  const thumbKey = `orgs/${org.id}/derived/load-test/thumb.webp`;
  const dir = path.resolve(process.env.STORAGE_LOCAL_DIR ?? ".data/storage");
  if ((process.env.STORAGE_DRIVER ?? "local") === "local") {
    await mkdir(path.join(dir, path.dirname(thumbKey)), { recursive: true });
    const img = await sharp({ create: { width: 480, height: 360, channels: 3, background: { r: 215, g: 205, b: 185 } } }).webp().toBuffer();
    await writeFile(path.join(dir, thumbKey), img);
  }

  const started = Date.now();
  let photos = 0;
  for (let c = 1; c <= 10; c++) {
    const catalog = await db.catalog.create({
      data: {
        organizationId: org.id,
        auctionHouseId: house.id,
        number: `${PREFIX}${String(c).padStart(2, "0")}-${Date.now().toString(36)}`,
        name: `בדיקת עומסים ${c}`,
        description: "נתוני בדיקת עומסים — אינם נתונים אמיתיים",
        status: "DRAFT",
        defaultRequirements: {},
      },
    });
    // one inventory book per lot (serials allocated in one atomic step)
    const [row] = await db.$queryRaw<{ seq: number }[]>`
      UPDATE "Organization" SET "inventorySerialSeq" = "inventorySerialSeq" + 100 WHERE id = ${org.id}::uuid RETURNING "inventorySerialSeq" AS seq`;
    const items = Array.from({ length: 100 }, (_, i) => {
      const serial = Number(row!.seq) - 99 + i;
      const number = String(10_000_000 + serial);
      return {
        id: randomUUID(),
        organizationId: org.id,
        serial,
        inventoryNumber: number,
        barcode: number,
        title: `ספר בדיקה ${i + 1}`,
        photoStatus: (["NOT_STARTED", "IN_PROGRESS", "PENDING_REVIEW", "COMPLETED", "NEEDS_RESHOOT"] as const)[i % 5],
        commercialStatus: "ASSIGNED" as const,
        requirements: {},
      };
    });
    await db.inventoryItem.createMany({ data: items });
    const lots = Array.from({ length: 100 }, (_, i) => ({
      id: randomUUID(),
      organizationId: org.id,
      catalogId: catalog.id,
      inventoryItemId: items[i]!.id,
      lotNumber: i + 1,
      sortOrder: i + 1,
      title: `ספר בדיקה ${i + 1}`,
      author: i % 3 === 0 ? "מחבר בדיקה" : null,
      status: (["NOT_STARTED", "IN_PROGRESS", "PENDING_REVIEW", "COMPLETED", "NEEDS_RESHOOT"] as const)[i % 5],
      requirements: {},
    }));
    await db.lot.createMany({ data: lots });
    const assets: Prisma.PhotoAssetCreateManyInput[] = [];
    const files: Prisma.PhotoFileCreateManyInput[] = [];
    for (const lot of lots) {
      const n = 20 + Math.floor(Math.random() * 31);
      const sortByCat: Record<string, number> = {};
      for (let s = 1; s <= n; s++) {
        const category = CATEGORIES[s % 4]!;
        sortByCat[category] = (sortByCat[category] ?? 0) + 1;
        const id = randomUUID();
        assets.push({
          id,
          organizationId: org.id,
          inventoryItemId: lot.inventoryItemId,
          catalogId: catalog.id,
          lotId: lot.id,
          category,
          captureId: randomUUID(),
          source: "SIMULATOR",
          sequence: s,
          sortOrder: sortByCat[category]!,
          width: 6960,
          height: 4640,
          capturedAt: new Date(),
          thumbKey,
          previewKey: thumbKey,
          processingStatus: "DONE",
          createdById: user.id,
        });
        files.push({
          assetId: id,
          role: "PRIMARY",
          originalFilename: `load-${s}.jpg`,
          mimeType: "image/jpeg",
          extension: "jpg",
          sizeBytes: BigInt(12_000_000),
          sha256: randomUUID().replace(/-/g, "").padEnd(64, "0"),
          storageKey: `orgs/${org.id}/load-test/${id}.jpg`,
          uploadStatus: "VERIFIED",
          verifiedAt: new Date(),
        });
      }
      photos += n;
    }
    for (let i = 0; i < assets.length; i += 5000) await db.photoAsset.createMany({ data: assets.slice(i, i + 5000) });
    for (let i = 0; i < files.length; i += 5000) await db.photoFile.createMany({ data: files.slice(i, i + 5000) });
    for (const lot of lots) {
      const count = assets.filter((a) => a.lotId === lot.id).length;
      await db.lot.update({ where: { id: lot.id }, data: { photoCount: count } });
      await db.inventoryItem.update({ where: { id: lot.inventoryItemId }, data: { photoCount: count } });
    }
    console.log(`catalog ${c}/10: 100 lots, ${assets.length} photos`);
  }
  console.log(`seeded ${photos} photos in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

(process.argv.includes("--purge") ? purge() : seed())
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
