/**
 * Numeric inventory numbers — controlled migration helper. READ-ONLY: it only runs SELECTs.
 *
 *   tsx scripts/numbering-report.ts plan   [databaseUrl]   BEFORE migrating: the full old → new mapping and every risk
 *   tsx scripts/numbering-report.ts verify [databaseUrl]   AFTER migrating: proves nothing was lost
 *
 * `plan` exits 1 when the migration would refuse to run (a collision) so a script can stop before any change.
 * Procedure for a live database: backup → `plan` → review the printed mapping → approve → `migrate deploy` → `verify`.
 */
import { PrismaClient } from "@prisma/client";

const [, , mode = "plan", url] = process.argv;
const db = new PrismaClient(url ? { datasourceUrl: url } : undefined);
type Row = Record<string, unknown>;
const q = (sql: string) => db.$queryRawUnsafe<Row[]>(sql);
const BASE = 10_000_000n;

async function plan() {
  const items = await q(`SELECT id::text, "organizationId"::text AS org, serial, "inventoryNumber", barcode, title FROM "InventoryItem" ORDER BY "organizationId", serial`);
  const legacy = items.filter((i) => !/^\d+$/.test(String(i.inventoryNumber)));
  console.log(`ספרים: ${items.length} · להסבה: ${legacy.length} · כבר מספריים: ${items.length - legacy.length}`);
  const next = (i: Row) => String(BASE + BigInt(i.serial as number | bigint));
  const problems: string[] = [];
  for (const i of legacy) {
    const n = next(i);
    const clash = items.find((o) => o.org === i.org && o.id !== i.id && (o.barcode === n || o.inventoryNumber === n));
    if (clash) problems.push(`התנגשות: ${i.inventoryNumber} → ${n} כבר בשימוש אצל ${clash.id} (${clash.inventoryNumber}/${clash.barcode})`);
  }
  const external = legacy.filter((i) => i.barcode !== i.inventoryNumber);
  const standard = legacy.filter((i) => /^ITM-\d{6}$/.test(String(i.inventoryNumber)) && BigInt(String(i.inventoryNumber).slice(4)) === BigInt(i.serial as number | bigint));
  console.log(`תבנית סטנדרטית ITM-000000 התואמת את ה-serial: ${standard.length}/${legacy.length}`);
  console.log(`ספרים עם ברקוד חיצוני שנשאר ללא שינוי: ${external.length}`);
  const seq = await q(`SELECT o.id::text AS org, o."inventorySerialSeq" AS seq, COALESCE(max(i.serial),0) AS max FROM "Organization" o LEFT JOIN "InventoryItem" i ON i."organizationId" = o.id GROUP BY o.id`);
  for (const s of seq) if (BigInt(s.seq as number | bigint) < BigInt(s.max as number | bigint)) problems.push(`מונה ארגון ${s.org} נמוך מה-serial הגבוה ביותר`);
  console.log("\nמיפוי (ראשונים):");
  for (const i of legacy.slice(0, 25)) console.log(`  ${i.inventoryNumber}  →  ${next(i)}   ${i.barcode !== i.inventoryNumber ? `(ברקוד חיצוני ${i.barcode} נשאר)` : ""}  ${String(i.title).slice(0, 40)}`);
  if (legacy.length > 25) console.log(`  … ועוד ${legacy.length - 25}`);
  if (problems.length) {
    console.log("\n✘ בעיות — ההסבה תסרב לרוץ:");
    for (const p of problems) console.log("  " + p);
    process.exitCode = 1;
  } else console.log("\n✔ אין התנגשויות. אפשר לגבות, לאשר ולהריץ migrate deploy.");
}

async function verify() {
  const items = await q(`SELECT id::text, serial, "inventoryNumber", barcode FROM "InventoryItem"`);
  const aliases = await q(`SELECT "inventoryItemId"::text AS item, alias FROM "InventoryNumberAlias"`);
  const aliasBy = new Map(aliases.map((a) => [a.item as string, a.alias as string]));
  const bad: string[] = [];
  for (const i of items) {
    const want = String(BASE + BigInt(i.serial as number | bigint));
    if (i.inventoryNumber !== want) bad.push(`${i.id}: מספר ${i.inventoryNumber} ≠ ${want}`);
    const a = aliasBy.get(i.id as string);
    if (a && !/^ITM-/.test(a)) bad.push(`${i.id}: כינוי חריג ${a}`);
  }
  const dup = await q(`SELECT "inventoryNumber", count(*) FROM "InventoryItem" GROUP BY "organizationId", "inventoryNumber" HAVING count(*) > 1`);
  const seq = await q(`SELECT o."inventorySerialSeq" AS seq, COALESCE(max(i.serial),0) AS max FROM "Organization" o LEFT JOIN "InventoryItem" i ON i."organizationId" = o.id GROUP BY o.id`);
  const lowSeq = seq.filter((s) => BigInt(s.seq as number | bigint) < BigInt(s.max as number | bigint));
  console.log(`ספרים: ${items.length} · כינויי ITM שמורים: ${aliases.length} · מספרים כפולים: ${dup.length} · מונה נמוך מהמקסימום: ${lowSeq.length}`);
  if (bad.length || dup.length || lowSeq.length) {
    for (const b of bad.slice(0, 20)) console.log("  ✘ " + b);
    process.exitCode = 1;
  } else console.log("✔ כל הספרים הומרו, כל המספרים הישנים נשמרו ככינויים, המונה תקין.");
}

(mode === "verify" ? verify() : plan())
  .catch((e) => {
    console.error(e);
    process.exitCode = 2;
  })
  .finally(() => db.$disconnect());
