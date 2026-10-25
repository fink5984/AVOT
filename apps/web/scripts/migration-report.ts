/**
 * Phase 2 migration reconciliation.
 *
 *   tsx scripts/migration-report.ts snapshot <out.json> [databaseUrl]   — BEFORE migrating (old schema)
 *   tsx scripts/migration-report.ts verify <snapshot.json> <report.md> [databaseUrl] — AFTER migrating
 *
 * Only raw SELECTs are used so the snapshot works against the pre-migration
 * schema. `verify` exits with code 1 when any check fails. It never writes to
 * the database. Used by scripts/migration-dry-run.ps1.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

type Row = Record<string, unknown>;
interface Snapshot {
  takenAt: string;
  catalogs: Row[];
  lots: Row[];
  assets: Row[];
  files: Row[];
  categoryNotes: Row[];
  auditCount: number;
}

const [, , mode, a, b, c] = process.argv;
const url = mode === "snapshot" ? b : c;
const db = new PrismaClient(url ? { datasourceUrl: url } : undefined);
const q = (sql: string) => db.$queryRawUnsafe<Row[]>(sql);

async function snapshot(out: string) {
  const snap: Snapshot = {
    takenAt: new Date().toISOString(),
    catalogs: await q(`SELECT id::text, "organizationId"::text AS org, number FROM "Catalog" ORDER BY id`),
    lots: await q(
      `SELECT id::text, "organizationId"::text AS org, "catalogId"::text AS "catalogId", "lotNumber", title, status::text AS status,
              "photoCount", "primaryAssetId"::text AS "primaryAssetId" FROM "Lot" ORDER BY id`,
    ),
    assets: await q(
      `SELECT id::text, "lotId"::text AS "lotId", "catalogId"::text AS "catalogId", category::text AS category, sequence, "sortOrder",
              "isPrimary", ("deletedAt" IS NOT NULL) AS deleted, "thumbKey", "previewKey" FROM "PhotoAsset" ORDER BY id`,
    ),
    files: await q(
      `SELECT id::text, "assetId"::text AS "assetId", "storageKey", sha256, "sizeBytes"::text AS size, "uploadStatus"::text AS status FROM "PhotoFile" ORDER BY id`,
    ),
    categoryNotes: await q(`SELECT "lotId"::text AS "lotId", category::text AS category, "needsReshoot", "notRequired", note FROM "LotCategoryNote"`),
    auditCount: Number((await q(`SELECT count(*)::int AS n FROM "AuditLog"`))[0]!.n),
  };
  writeFileSync(out, JSON.stringify(snap, null, 1));
  console.log(`snapshot: ${snap.catalogs.length} catalogs, ${snap.lots.length} lots, ${snap.assets.length} photos, ${snap.files.length} files → ${out}`);
}

interface Check {
  name: string;
  expected: string | number;
  actual: string | number;
  ok: boolean;
  details?: string[];
}

async function verify(snapPath: string, reportPath: string) {
  const snap = JSON.parse(readFileSync(snapPath, "utf8")) as Snapshot;
  const checks: Check[] = [];
  const add = (name: string, expected: string | number, actual: string | number, details: string[] = []) =>
    checks.push({ name, expected, actual, ok: expected === actual && details.length === 0, details: details.slice(0, 20) });

  const lots = await q(
    `SELECT l.id::text, l."catalogId"::text AS "catalogId", l."lotNumber", l.title, l.status::text AS status, l."inventoryItemId"::text AS item,
            l."assignmentStatus"::text AS assignment, i."migratedFromLotId"::text AS "migratedFrom", i.title AS "itemTitle",
            i."photoStatus"::text AS "itemPhotoStatus", i."inventoryNumber", i.barcode, i."primaryAssetId"::text AS "itemPrimary"
     FROM "Lot" l LEFT JOIN "InventoryItem" i ON i.id = l."inventoryItemId"`,
  );
  const lotById = new Map(lots.map((l) => [l.id as string, l]));
  const missingLots = snap.lots.filter((l) => !lotById.has(l.id as string)).map((l) => `lot ${l.id} missing`);
  add("כל הפריטים הקיימים נשמרו (אותו מזהה)", snap.lots.length, snap.lots.length - missingLots.length, missingLots);

  const lotDiffs: string[] = [];
  for (const old of snap.lots) {
    const now = lotById.get(old.id as string);
    if (!now) continue;
    if (now.catalogId !== old.catalogId || now.lotNumber !== old.lotNumber || now.title !== old.title) lotDiffs.push(`lot ${old.id}: catalog/number/title changed`);
    if (!now.item) lotDiffs.push(`lot ${old.id}: no inventory item`);
    else if (now.migratedFrom !== old.id) lotDiffs.push(`lot ${old.id}: item ${now.item} not migrated from this lot`);
    else if (now.itemTitle !== old.title || now.itemPhotoStatus !== old.status) lotDiffs.push(`lot ${old.id}: item title/status differ`);
    if (now.itemPrimary !== old.primaryAssetId) lotDiffs.push(`lot ${old.id}: primary photo differs`);
  }
  add("פריט קטלוג ↔ ספר מלאי: מספר, שם, סטטוס צילום, תמונה ראשית", 0, lotDiffs.length, lotDiffs);

  const items = await q(`SELECT id::text, "organizationId"::text AS org, serial, "inventoryNumber", barcode FROM "InventoryItem"`);
  const migratedItems = items.filter((i) => lots.some((l) => l.item === i.id && l.migratedFrom === l.id));
  add("ספר מלאי אחד לכל פריט ישן", snap.lots.length, migratedItems.length);
  const badNumbers = items.filter((i) => i.inventoryNumber !== `ITM-${String(i.serial).padStart(6, "0")}` || i.barcode !== i.inventoryNumber).map((i) => `${i.id}: ${i.inventoryNumber}`);
  add("מספרי מלאי בפורמט ITM-000000 וברקוד תואם", 0, badNumbers.length, badNumbers);
  const seq = await q(`SELECT o.id::text, o."inventorySerialSeq" AS seq, COALESCE(max(i.serial),0) AS max FROM "Organization" o LEFT JOIN "InventoryItem" i ON i."organizationId" = o.id GROUP BY o.id`);
  add("מונה מספרי מלאי ≥ המספר הגבוה ביותר", 0, seq.filter((s) => Number(s.seq) < Number(s.max)).length);

  const assets = await q(
    `SELECT p.id::text, p."lotId"::text AS "lotId", p."catalogId"::text AS "catalogId", p."inventoryItemId"::text AS item, p.category::text AS category,
            p.sequence, p."sortOrder", p."isPrimary", (p."deletedAt" IS NOT NULL) AS deleted, p."thumbKey", p."previewKey" FROM "PhotoAsset" p`,
  );
  const assetById = new Map(assets.map((x) => [x.id as string, x]));
  const assetDiffs: string[] = [];
  for (const old of snap.assets) {
    const now = assetById.get(old.id as string);
    if (!now) {
      assetDiffs.push(`photo ${old.id} missing`);
      continue;
    }
    const lot = lotById.get(old.lotId as string);
    if (now.lotId !== old.lotId || now.catalogId !== old.catalogId) assetDiffs.push(`photo ${old.id}: provenance lot/catalog changed`);
    if (!lot || now.item !== lot.item) assetDiffs.push(`photo ${old.id}: not attached to the lot's inventory item`);
    for (const k of ["category", "sequence", "sortOrder", "isPrimary", "deleted", "thumbKey", "previewKey"] as const) {
      if (now[k] !== old[k]) assetDiffs.push(`photo ${old.id}: ${k} changed`);
    }
  }
  add("תמונות: כולן שויכו לספר המלאי, סדר/קטגוריה/מחיקה רכה ללא שינוי", 0, assetDiffs.length, assetDiffs);

  const files = await q(`SELECT id::text, "assetId"::text AS "assetId", "storageKey", sha256, "sizeBytes"::text AS size, "uploadStatus"::text AS status FROM "PhotoFile"`);
  const fileById = new Map(files.map((f) => [f.id as string, f]));
  const fileDiffs = snap.files
    .filter((f) => {
      const n = fileById.get(f.id as string);
      return !n || n.storageKey !== f.storageKey || n.sha256 !== f.sha256 || n.size !== f.size || n.status !== f.status || n.assetId !== f.assetId;
    })
    .map((f) => `file ${f.id} (${f.storageKey})`);
  add("קבצי מקור: Storage Key, SHA-256, גודל וסטטוס זהים", 0, fileDiffs.length, fileDiffs);

  const counts = await q(`SELECT "inventoryItemId"::text AS item, count(*)::int AS n FROM "PhotoAsset" WHERE "deletedAt" IS NULL GROUP BY 1`);
  const countByItem = new Map(counts.map((r) => [r.item as string, Number(r.n)]));
  const countDiffs = snap.lots
    .filter((l) => {
      const item = lotById.get(l.id as string)?.item as string | undefined;
      return (countByItem.get(item ?? "") ?? 0) !== Number(l.photoCount);
    })
    .map((l) => `lot ${l.id}: photoCount ${l.photoCount} vs item ${countByItem.get((lotById.get(l.id as string)?.item as string) ?? "") ?? 0}`);
  add("מספר תמונות פעילות לכל ספר = מונה הפריט הישן", 0, countDiffs.length, countDiffs);

  const dupActive = await q(`SELECT "inventoryItemId"::text AS item FROM "Lot" WHERE "assignmentStatus" = 'ACTIVE' GROUP BY 1 HAVING count(*) > 1`);
  add("אין ספר עם שני שיוכים פעילים", 0, dupActive.length);

  const cats = await q(`SELECT c.id::text, h.slug FROM "Catalog" c LEFT JOIN "AuctionHouse" h ON h.id = c."auctionHouseId"`);
  add("כל הקטלוגים הקיימים שויכו לבית המכירות אבות", snap.catalogs.length, cats.filter((x) => snap.catalogs.some((s) => s.id === x.id) && x.slug === "avot").length);
  const houses = await q(`SELECT "organizationId"::text AS org, array_agg(slug ORDER BY slug)::text AS slugs FROM "AuctionHouse" GROUP BY 1`);
  add("שני בתי מכירות (avot, tavin) בכל ארגון", 0, houses.filter((h) => h.slugs !== "{avot,tavin}").length);

  const notes = await q(`SELECT n."inventoryItemId"::text AS item, n.category::text AS category FROM "InventoryCategoryNote" n`);
  add("סימוני קטגוריה הועתקו לספרי המלאי", snap.categoryNotes.length, notes.length);
  const audit = Number((await q(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action <> 'inventory.migrated'`))[0]!.n);
  add("יומן פעילות: אף רשומה לא נמחקה", snap.auditCount, Math.min(audit, snap.auditCount));
  const legacyNotes = Number((await q(`SELECT count(*)::int AS n FROM "LotCategoryNote"`))[0]!.n);
  add("טבלאות ישנות נשמרו (LotCategoryNote)", snap.categoryNotes.length, legacyNotes);

  const failed = checks.filter((x) => !x.ok);
  const lines = [
    `# דו"ח התאמה — מיגרציית מלאי מרכזי (Phase 2)`,
    "",
    `- צילום מצב לפני: ${snap.takenAt}`,
    `- בדיקה: ${new Date().toISOString()}`,
    `- לפני: ${snap.catalogs.length} קטלוגים · ${snap.lots.length} פריטים · ${snap.assets.length} תמונות · ${snap.files.length} קבצים`,
    `- אחרי: ${items.length} ספרי מלאי · ${lots.length} שיוכי קטלוג · ${assets.length} תמונות · ${files.length} קבצים`,
    `- תוצאה: **${failed.length === 0 ? "תקין — כל הבדיקות עברו" : `נכשל — ${failed.length} בדיקות`}**`,
    "",
    "| בדיקה | צפוי | בפועל | תוצאה |",
    "|---|---|---|---|",
    ...checks.map((x) => `| ${x.name} | ${x.expected} | ${x.actual} | ${x.ok ? "✔" : "✘"} |`),
    "",
    ...failed.flatMap((x) => [`## ✘ ${x.name}`, ...(x.details ?? []).map((d) => `- ${d}`), ""]),
  ];
  writeFileSync(reportPath, lines.join("\n"));
  console.log(lines.join("\n"));
  if (failed.length) process.exitCode = 1;
}

async function main() {
  if (mode === "snapshot" && a) await snapshot(a);
  else if (mode === "verify" && a && b) await verify(a, b);
  else {
    console.error("usage: migration-report.ts snapshot <out.json> [url] | verify <snapshot.json> <report.md> [url]");
    process.exitCode = 2;
  }
}

main().finally(() => db.$disconnect());
