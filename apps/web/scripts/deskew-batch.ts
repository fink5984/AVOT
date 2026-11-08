/**
 * Straightening (auto deskew) of the photos that already exist. Same engine as new photos — see
 * src/server/services/deskew-batch.ts. Stages, in this order:
 *
 *   1. dry-run   measures every photo, writes a report; changes NOTHING (no database write, no file written)
 *   2. preview   renders ~30 photos before / after into one HTML page; changes NOTHING
 *   3. approve   a person who looked at the preview records the approval for this algorithm version
 *   4. run       plans a batch and processes it in small steps (needs the approval; --resume continues)
 *      status / pause / resume / rollback <batchId>
 *
 *   npm run deskew -w apps/web -- dry-run  [--org <id>] [--limit N] [--out dir]
 *   npm run deskew -w apps/web -- preview  [--org <id>] [--count 30] [--from dir] [--out dir]
 *   npm run deskew -w apps/web -- approve  --preview <dir>
 *   npm run deskew -w apps/web -- run      [--org <id>] [--limit N] [--force] [--pause-ms 300] [--max-rss-mb 2500] [--threads 2] [--resume <batchId>]
 *   npm run deskew -w apps/web -- status   <batchId>
 *   npm run deskew -w apps/web -- pause    <batchId>
 *   npm run deskew -w apps/web -- rollback <batchId>
 *
 * It uses DATABASE_URL and the storage of .env.local — point it at the database you mean to change.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { db } from "../src/server/db";
import { DESKEW_ALGO_VERSION } from "../src/lib/imaging/deskew";
import { SKIP_LABEL, VERDICT_LABEL, pickPreviewSample, reportCsv, summaryText, totalsOf, type ReportRow } from "../src/lib/imaging/deskew-report";
import { batchProgress, examineAll, planBatch, renderComparison, rollbackBatch, runBatch, setBatchStatus } from "../src/server/services/deskew-batch";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : "true") : undefined;
};
const REPORTS = path.resolve(process.cwd(), "deskew-reports");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const approvalFile = () => path.join(REPORTS, `approved-v${DESKEW_ALGO_VERSION}.json`);

async function orgId(): Promise<string> {
  const given = flag("org");
  if (given) return given;
  const orgs = await db.organization.findMany({ select: { id: true, name: true } });
  if (orgs.length !== 1) throw new Error(`pass --org <id>; organizations: ${orgs.map((o) => `${o.id} (${o.name})`).join(", ")}`);
  return orgs[0]!.id;
}

function mkOut(name: string): string {
  const dir = flag("out") ?? path.join(REPORTS, `${name}-${stamp()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function dryRun() {
  const org = await orgId();
  const out = mkOut("dry-run");
  console.log(`dry run — nothing is written to the database or to storage. report: ${out}`);
  const rows = await examineAll(org, {
    limit: flag("limit") ? Number(flag("limit")) : undefined,
    onRow: (r, i) => {
      if (i % 25 === 0) console.log(`  ${i + 1} examined…`);
      if (r.verdict === "error") console.warn(`  error ${r.assetId}: ${r.error}`);
    },
  });
  writeFileSync(path.join(out, "report.json"), JSON.stringify({ algo: DESKEW_ALGO_VERSION, org, rows }, null, 1));
  writeFileSync(path.join(out, "report.csv"), reportCsv(rows));
  const text = summaryText(totalsOf(rows), { algo: DESKEW_ALGO_VERSION, startedAt: new Date().toISOString(), org });
  writeFileSync(path.join(out, "summary.txt"), text);
  console.log("\n" + text + `files: ${path.join(out, "summary.txt")}, report.csv, report.json`);
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function preview() {
  const org = await orgId();
  const count = flag("count") ? Number(flag("count")) : 30;
  const out = mkOut("preview");
  let rows: ReportRow[];
  const from = flag("from");
  if (from) {
    rows = (JSON.parse(readFileSync(path.join(from, "report.json"), "utf8")) as { rows: ReportRow[] }).rows;
    console.log(`sample from the dry-run report ${from} (${rows.length} photos)`);
  } else {
    console.log("no dry-run report given: examining all photos first (nothing is written)…");
    rows = await examineAll(org, { limit: flag("limit") ? Number(flag("limit")) : undefined });
  }
  const sample = pickPreviewSample(rows, count);
  console.log(`rendering ${sample.length} comparisons into ${out} (nothing is written to the database or to storage)`);
  const cards: string[] = [];
  const picked: ReportRow[] = [];
  for (const [i, r] of sample.entries()) {
    try {
      const c = await renderComparison(r.assetId);
      const img = (b: Buffer | null) => (b ? `<img src="data:image/jpeg;base64,${b.toString("base64")}">` : "<div class=none>אין</div>");
      const verdict = c.angle !== 0 ? `סיבוב ב-${c.angle > 0 ? "+" : ""}${c.angle.toFixed(2)}°` : "לא מסתובב";
      const reason = c.skip ? SKIP_LABEL[c.skip as keyof typeof SKIP_LABEL] ?? c.skip : "מתקיימים כל התנאים לסיבוב";
      cards.push(`<section class="${c.angle !== 0 ? "go" : "stay"}"><h3>${i + 1}. ${esc(r.inventoryNumber)} · ${esc(r.itemType)} · ${esc(r.category)}</h3>
<div class=pair><figure>${img(c.before)}<figcaption>לפני (גרסה מעובדת נוכחית)</figcaption></figure><figure>${img(c.after)}<figcaption>אחרי (כך ייראה)</figcaption></figure></div>
<p><b>${verdict}</b> · ביטחון ${c.confidence.toFixed(2)} · סוג זיהוי: ${esc(c.kind)} · ${esc(VERDICT_LABEL[c.decision])}<br>סיבה: ${esc(reason)}</p></section>`);
      picked.push(r);
      console.log(`  ${i + 1}/${sample.length} ${r.inventoryNumber ?? r.assetId}: ${verdict}`);
    } catch (err) {
      console.warn(`  ${r.assetId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  const html = `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>השוואת יישור — לפני ואחרי</title>
<style>body{font-family:Segoe UI,Arial;margin:24px;background:#f4f4f2;color:#222}section{background:#fff;border-radius:8px;padding:12px 16px;margin:0 0 18px;border-right:6px solid #bbb}section.go{border-color:#2a8a3a}h3{margin:0 0 8px}
.pair{display:flex;gap:12px;flex-wrap:wrap}figure{margin:0;flex:1 1 300px;text-align:center}img{max-width:100%;max-height:520px;background:repeating-conic-gradient(#eee 0 25%,#fff 0 50%) 0 0/16px 16px}figcaption{font-size:13px;color:#666}.none{padding:60px;color:#999}p{margin:8px 0 0}</style>
<h1>השוואת יישור — ${picked.length} תמונות (גרסת אלגוריתם ${DESKEW_ALGO_VERSION})</h1>
<p>מסגרת ירוקה = היישור יתבצע. מסגרת אפורה = התמונה נשארת כפי שהיא. לא נכתב דבר לנתונים או לקבצים.</p>${cards.join("\n")}</html>`;
  writeFileSync(path.join(out, "preview.html"), html);
  writeFileSync(path.join(out, "sample.json"), JSON.stringify({ algo: DESKEW_ALGO_VERSION, org, rows: picked }, null, 1));
  console.log(`\nopen: ${path.join(out, "preview.html")}\nafter checking it, approve with:  approve --preview ${out}`);
}

function approve() {
  const dir = flag("preview");
  if (!dir || !existsSync(path.join(dir, "preview.html"))) throw new Error("usage: approve --preview <dir containing preview.html>");
  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(approvalFile(), JSON.stringify({ algo: DESKEW_ALGO_VERSION, preview: path.resolve(dir), approvedAt: new Date().toISOString() }, null, 1));
  console.log(`approved for algorithm version ${DESKEW_ALGO_VERSION}. A run may now start.`);
}

let stopRequested = false;

async function run() {
  const resume = flag("resume");
  let batchId = resume;
  if (!batchId) {
    if (!existsSync(approvalFile())) {
      throw new Error(`refusing to run: no approval for algorithm version ${DESKEW_ALGO_VERSION}. Run dry-run and preview, look at the comparison, then "approve --preview <dir>".`);
    }
    const org = await orgId();
    const { batch, planned, preSkipped } = await planBatch(org, { limit: flag("limit") ? Number(flag("limit")) : undefined, force: flag("force") === "true", startedBy: "cli" });
    batchId = batch.id;
    console.log(`batch ${batchId}: ${planned} photos planned, ${preSkipped} recorded as not examined`);
  }
  if (flag("threads")) sharp.concurrency(Number(flag("threads")));
  else sharp.concurrency(2);
  process.on("SIGINT", async () => {
    console.log("\nstopping after the current photo… (continue later with: run --resume " + batchId + ")");
    stopRequested = true;
    await setBatchStatus(batchId!, "PAUSED").catch(() => undefined);
  });
  const p = await runBatch(batchId, {
    pauseMs: flag("pause-ms") ? Number(flag("pause-ms")) : 300,
    maxRssMb: flag("max-rss-mb") ? Number(flag("max-rss-mb")) : 2500,
    maxItems: flag("max-items") ? Number(flag("max-items")) : undefined,
    shouldStop: () => stopRequested,
    onProgress: (x) => console.log(`  ${x.total - x.pending}/${x.total}  applied ${x.applied} · unchanged ${x.skipped} · failed ${x.failed} · waiting ${x.pending}`),
  });
  console.log(`\nbatch ${batchId}: ${p.status}`, p);
  if (p.status === "PAUSED") console.log(`continue with: run --resume ${batchId}`);
}

async function main() {
  switch (cmd) {
    case "dry-run":
      return dryRun();
    case "preview":
      return preview();
    case "approve":
      return approve();
    case "run":
      return run();
    case "status": {
      const id = argv[1];
      if (!id) throw new Error("usage: status <batchId>");
      return void console.log(await batchProgress(id));
    }
    case "pause": {
      const id = argv[1];
      if (!id) throw new Error("usage: pause <batchId>");
      await setBatchStatus(id, "PAUSED");
      return void console.log("paused (the running process stops after the current photo)");
    }
    case "rollback": {
      const id = argv[1];
      if (!id) throw new Error("usage: rollback <batchId>");
      const r = await rollbackBatch(id);
      console.log(`restored ${r.restored} photos to their previous version`, r.notRestored.length ? `\nnot restored (${r.notRestored.length}):\n${r.notRestored.map((n) => `  ${n.assetId}: ${n.reason}`).join("\n")}` : "");
      return;
    }
    default:
      console.log("commands: dry-run | preview | approve | run | status <id> | pause <id> | rollback <id>   (see the header of scripts/deskew-batch.ts)");
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
