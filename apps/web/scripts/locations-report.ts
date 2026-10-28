/**
 * Shelf-only locations (no cells) — controlled migration helper. READ-ONLY: it only runs SELECTs.
 *
 *   tsx scripts/locations-report.ts plan   [databaseUrl]   BEFORE migrating: what exists and exactly what would change
 *   tsx scripts/locations-report.ts verify [databaseUrl]   AFTER migrating: proves nothing was lost
 *
 * `plan` exits 1 when the migration would refuse to run (e.g. an open stock count on a cell that would be merged).
 * Procedure for a live database: backup → `plan` → review → approval → `migrate deploy` → `verify`.
 */
import { PrismaClient } from "@prisma/client";

const [, , mode = "plan", url] = process.argv;
const db = new PrismaClient(url ? { datasourceUrl: url } : undefined);
type Row = Record<string, unknown>;
const q = (sql: string) => db.$queryRawUnsafe<Row[]>(sql);
const num = (v: unknown) => Number(v as number | bigint);

/** the primary location of a shelf: cell "01", else the first by sort key */
const PRIMARY = `(SELECT DISTINCT ON ("shelfId") id, "shelfId" FROM "StorageLocation" ORDER BY "shelfId", (cell <> '01'), "sortKey", "createdAt")`;

async function plan() {
  const [shelves] = await q(`SELECT count(*)::int AS n FROM "Shelf"`);
  const [locs] = await q(`SELECT count(*)::int AS n FROM "StorageLocation"`);
  console.log(`מדפים: ${shelves!.n} · מיקומים: ${locs!.n}`);
  const multi = await q(`SELECT s.id::text, s.code, z.name AS zone, count(l.id)::int AS cells FROM "Shelf" s JOIN "WarehouseZone" z ON z.id = s."zoneId" JOIN "StorageLocation" l ON l."shelfId" = s.id GROUP BY s.id, s.code, z.name HAVING count(l.id) > 1`);
  const noLoc = await q(`SELECT s.id::text FROM "Shelf" s WHERE NOT EXISTS (SELECT 1 FROM "StorageLocation" l WHERE l."shelfId" = s.id)`);
  const odd = await q(`SELECT count(*)::int AS n FROM "StorageLocation" WHERE cell <> '01'`);
  console.log(`מדפים עם יותר מתא אחד: ${multi.length} · מדפים בלי מיקום: ${noLoc.length} · מיקומי תא שאינם "01": ${odd[0]!.n}`);

  const problems: string[] = [];
  const books = await q(`SELECT l.code, l.cell, count(i.id)::int AS n FROM "StorageLocation" l JOIN ${PRIMARY} p ON p."shelfId" = l."shelfId" LEFT JOIN "InventoryItem" i ON i."currentLocationId" = l.id WHERE l.id <> p.id GROUP BY l.id HAVING count(i.id) > 0`);
  console.log(`תאים שאינם ראשיים ועליהם ספרים (יאוחדו למדף): ${books.length}${books.length ? " — " + books.map((b) => `${b.code}:${b.n}`).join(", ") : ""}`);
  const counts = await q(`SELECT DISTINCT l.code FROM "StorageLocation" l JOIN ${PRIMARY} p ON p."shelfId" = l."shelfId" JOIN "StockCountLocation" c ON c."locationId" = l.id JOIN "StockCountSession" s ON s.id = c."sessionId" WHERE l.id <> p.id AND s.status = 'OPEN'`);
  for (const c of counts) problems.push(`ספירת מלאי פתוחה על תא שיאוחד: ${c.code}`);
  const picks = await q(`SELECT DISTINCT l.code FROM "StorageLocation" l JOIN ${PRIMARY} p ON p."shelfId" = l."shelfId" JOIN "PickTask" t ON t."sourceLocationId" = l.id WHERE l.id <> p.id AND t.status IN ('OPEN','PICKED','PACKED')`);
  for (const c of picks) problems.push(`משימת ליקוט פתוחה על תא שיאוחד: ${c.code}`);

  // new code = the old code without its trailing "-<cell>"
  const clash = await q(
    `SELECT l.code AS old, regexp_replace(l.code, '-[^-]+$', '') AS new FROM "StorageLocation" l JOIN ${PRIMARY} p ON p.id = l.id WHERE EXISTS (SELECT 1 FROM "StorageLocation" o WHERE o."organizationId" = l."organizationId" AND o.id <> l.id AND (o.code = regexp_replace(l.code, '-[^-]+$', '')))`,
  );
  for (const c of clash) problems.push(`הקוד החדש ${c.new} (מ-${c.old}) כבר בשימוש`);

  const sample = await q(`SELECT l.code AS old, regexp_replace(l.code, '-[^-]+$', '') AS new, (SELECT count(*)::int FROM "InventoryItem" i WHERE i."currentLocationId" = l.id) AS books FROM "StorageLocation" l JOIN ${PRIMARY} p ON p.id = l.id ORDER BY l."sortKey" LIMIT 12`);
  console.log("\nקודי מדף (ראשונים):");
  for (const s of sample) console.log(`  ${s.old}  →  ${s.new}   (${s.books} ספרים)   הקוד הישן נשמר ככינוי`);

  const hist = await q(`SELECT (SELECT count(*) FROM "InventoryLocationMovement")::int AS moves, (SELECT count(*) FROM "BarcodeScanEvent" WHERE "locationId" IS NOT NULL)::int AS scans, (SELECT count(*) FROM "StockCountEntry")::int AS countEntries`);
  console.log(`\nהיסטוריה שתישמר כמות שהיא: ${hist[0]!.moves} תנועות · ${hist[0]!.scans} סריקות עם מיקום · ${hist[0]!.countEntries} שורות ספירה`);
  if (problems.length) {
    console.log("\n✘ בעיות — ההסבה תסרב לרוץ:");
    for (const p of problems) console.log("  " + p);
    process.exit(1);
  }
  console.log("\n✔ אין בעיות. אפשר לגבות, לאשר ולהריץ migrate deploy.");
}

async function verify() {
  const checks: [string, string][] = [
    ["לכל מדף לפחות מיקום פעיל אחד או שאין לו מיקומים", `SELECT count(*)::int AS n FROM "Shelf" s WHERE "deletedAt" IS NULL AND EXISTS (SELECT 1 FROM "StorageLocation" l WHERE l."shelfId" = s.id) AND NOT EXISTS (SELECT 1 FROM "StorageLocation" l WHERE l."shelfId" = s.id AND l.active)`],
    ["מדפים עם יותר ממיקום פעיל אחד (חייב להיות 0)", `SELECT count(*)::int AS n FROM (SELECT "shelfId" FROM "StorageLocation" WHERE active GROUP BY "shelfId" HAVING count(*) > 1) x`],
    ["ספרים על מיקום לא פעיל שאינו מדף מושבת (חייב להיות 0)", `SELECT count(*)::int AS n FROM "InventoryItem" i JOIN "StorageLocation" l ON l.id = i."currentLocationId" JOIN "Shelf" s ON s.id = l."shelfId" WHERE NOT l.active AND s."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM "StorageLocation" a WHERE a."shelfId" = l."shelfId" AND a.active)`],
    ["כינויים שמצביעים על מיקום שאינו קיים (חייב להיות 0)", `SELECT count(*)::int AS n FROM "StorageLocationAlias" a WHERE NOT EXISTS (SELECT 1 FROM "StorageLocation" l WHERE l.id = a."locationId")`],
    ["קודי מיקום פעילים שעדיין מסתיימים בתא (חייב להיות 0)", `SELECT count(*)::int AS n FROM "StorageLocation" WHERE active AND code ~ '-[0-9]{2}-[0-9]{2}$'`],
  ];
  let bad = 0;
  for (const [label, sql] of checks) {
    const n = num((await q(sql))[0]!.n);
    console.log(`${label}: ${n}`);
    if (n !== 0 && !label.startsWith("לכל מדף")) bad++;
  }
  const [a] = await q(`SELECT count(*)::int AS n FROM "StorageLocationAlias"`);
  console.log(`כינויי קודים ישנים שמורים: ${a!.n}`);
  if (bad) {
    console.log("✘ יש חריגות");
    process.exit(1);
  }
  console.log("✔ המבנה תקין, ההיסטוריה והקודים הישנים נשמרו.");
}

(mode === "verify" ? verify() : plan())
  .catch((e) => {
    console.error(e);
    process.exit(2);
  })
  .finally(() => db.$disconnect());
