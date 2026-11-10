/**
 * Local, one-off fix for photos whose automatic crop went wrong (another object in the frame, green left behind).
 * Not part of the system: it only calls the existing processing engine with a manual crop around the MAIN object.
 *
 *   npm run fix-crop -w apps/web -- <inventoryNumber | assetId> [...] [--apply] [--margin 2]
 *
 * Without --apply nothing is written: a before/after page is produced in ./fix-crop-reports for you to look at.
 * With --apply the new version is written under NEW storage keys, the photo points at it, and the previous
 * version is saved to ./fix-crop-reports/rollback-<time>.json (restore with: fix-crop --rollback <that file>).
 * The photo's stored settings are not changed (the crop lives only in the new file); the straightening is recorded in its result.
 * --no-deskew crops only.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { photoProcessingSchema, residualRotation } from "@avot/shared";
import { Prisma } from "@prisma/client";
import { db } from "../src/server/db";
import { storage } from "../src/server/storage";
import { processBook } from "../src/server/services/book-image";
import { deriveImages, flattenColor, parseProcessing, resultInfo } from "../src/server/services/derivatives";
import { segmentBook } from "../src/lib/imaging/segment";
import { decideDeskew, deskewInfo, skipped, type DeskewDecision } from "../src/lib/imaging/deskew";
import { dilate, erode, labelComponents } from "../src/lib/imaging/raster";

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : "true") : undefined;
};
const targets = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1]!.startsWith("--") && ["margin", "rollback", "from", "shard", "limit"].includes(argv[i - 1]!.slice(2))));
const REPORTS = path.resolve(process.cwd(), "fix-crop-reports");
const apply = flag("apply") === "true";
const margin = flag("margin") ? Number(flag("margin")) : undefined;

/** the main object = large and near the middle; thin strips at the frame (table edge, a hand, a cloth) lose */
function mainCrop(rawMask: Uint8Array, w: number, h: number): { x: number; y: number; w: number; h: number; mask: Uint8Array; others: number } | null {
  // opening: a strip narrower than ~2·OPEN px that touches the book (table edge, a cloth) is cut away from it
  const OPEN = 9;
  const mask = dilate(erode(rawMask, w, h, OPEN), w, h, OPEN);
  const c = labelComponents(mask, w, h);
  if (c.count === 0) return null;
  const box = Array.from({ length: c.count + 1 }, () => ({ x0: w, y0: h, x1: 0, y1: 0, edge: 0 }));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const l = c.labels[y * w + x]!;
      if (!l) continue;
      const b = box[l]!;
      if (x < b.x0) b.x0 = x;
      if (y < b.y0) b.y0 = y;
      if (x >= b.x1) b.x1 = x + 1;
      if (y >= b.y1) b.y1 = y + 1;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) b.edge++;
    }
  let best = 0;
  let bestScore = -1;
  for (let l = 1; l <= c.count; l++) {
    const b = box[l]!;
    const bw = b.x1 - b.x0;
    const bh = b.y1 - b.y0;
    const fill = c.areas[l]! / Math.max(1, bw * bh);
    const cx = (b.x0 + b.x1) / 2 / w - 0.5;
    const cy = (b.y0 + b.y1) / 2 / h - 0.5;
    const central = 1 - Math.min(1, Math.hypot(cx, cy) * 1.4);
    const thin = Math.min(bw, bh) / Math.max(bw, bh) < 0.12 ? 0.2 : 1;
    const score = c.areas[l]! * (0.4 + central) * (0.5 + fill) * thin * (b.edge > 0.1 * (bw + bh) ? 0.5 : 1);
    if (score > bestScore) {
      bestScore = score;
      best = l;
    }
  }
  const b = box[best]!;
  const only = new Uint8Array(w * h);
  for (let i = 0; i < only.length; i++) if (c.labels[i] === best) only[i] = 1;
  // other substantial, non-thin objects (several books on purpose) — a composition is not cropped to one of them
  let others = 0;
  for (let l = 1; l <= c.count; l++) {
    if (l === best) continue;
    const o = box[l]!;
    const ow = o.x1 - o.x0;
    const oh = o.y1 - o.y0;
    if (c.areas[l]! >= 0.25 * c.areas[best]! && Math.min(ow, oh) / Math.max(ow, oh) >= 0.12) others++;
  }
  return { x: b.x0 / w, y: b.y0 / h, w: (b.x1 - b.x0) / w, h: (b.y1 - b.y0) / h, mask: dilate(only, w, h, 0), others };
}

/** oriented full-resolution pixels turned by the profile rotation PLUS the deskew angle in ONE resampling, kept lossless (PNG) for the engine */
async function straightened(input: Buffer, rotation: number, angle: number, fill: [number, number, number]): Promise<Buffer> {
  const meta = await sharp(input).metadata();
  const res = residualRotation(meta.orientation, rotation as never);
  const first = await sharp(input, { failOn: "error" }).rotate().toColourspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const turned = await sharp(first.data, { raw: { width: first.info.width, height: first.info.height, channels: 3 } })
    .rotate(res + angle, { background: { r: Math.round(fill[0]), g: Math.round(fill[1]), b: Math.round(fill[2]) } })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return sharp(turned.data, { raw: { width: turned.info.width, height: turned.info.height, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
}

async function working(input: Buffer, rotation: number) {
  const meta = await sharp(input).metadata();
  const res = residualRotation(meta.orientation, rotation as never);
  const first = await sharp(input, { failOn: "error" }).rotate().resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).toColourspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (res === 0) return { data: first.data, w: first.info.width, h: first.info.height };
  const t = await sharp(first.data, { raw: { width: first.info.width, height: first.info.height, channels: 3 } }).rotate(res).raw().toBuffer({ resolveWithObject: true });
  return { data: t.data, w: t.info.width, h: t.info.height };
}

async function rollback(file: string) {
  const snap = JSON.parse(readFileSync(file, "utf8")) as { id: string; newKey: string; previous: Record<string, unknown> }[];
  for (const s of snap) {
    const p = s.previous as { processing: unknown; processingResult: unknown } & Record<string, never>;
    const r = await db.photoAsset.updateMany({
      where: { id: s.id, processedKey: s.newKey },
      data: {
        processedKey: p.processedKey,
        processedMime: p.processedMime,
        processedWidth: p.processedWidth,
        processedHeight: p.processedHeight,
        thumbKey: p.thumbKey,
        previewKey: p.previewKey,
        imageState: p.imageState,
        processing: p.processing === null ? Prisma.DbNull : (p.processing as object),
        processingResult: p.processingResult === null ? Prisma.DbNull : (p.processingResult as object),
      },
    });
    console.log(s.id, r.count ? "restored" : "not restored (changed since)");
  }
}

async function main() {
  const rb = flag("rollback");
  if (rb) return rollback(rb);
  const from = flag("from");
  if (targets.length === 0 && !from) throw new Error("usage: fix-crop <inventoryNumber | assetId> ... [--apply]  |  --auto --from <inventoryNumber> [--shard k/n] [--detect] [--apply]");
  mkdirSync(REPORTS, { recursive: true });
  const [shardK, shardN] = (flag("shard") ?? "0/1").split("/").map(Number) as [number, number];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + (shardN > 1 ? `-s${shardK}` : "");
  const auto = !!from;
  const detectOnly = flag("detect") === "true";
  const limit = flag("limit") ? Number(flag("limit")) : undefined;
  const assets = [] as Awaited<ReturnType<typeof db.photoAsset.findMany<{ include: { files: true; item: { select: { inventoryNumber: true } } } }>>>;
  if (auto) {
    const all = await db.photoAsset.findMany({
      where: { deletedAt: null, imageState: { in: ["DONE", "NEEDS_REVIEW"] }, item: { inventoryNumber: { gte: from! } } },
      include: { files: true, item: { select: { inventoryNumber: true } } },
      orderBy: [{ item: { inventoryNumber: "asc" } }, { createdAt: "asc" }],
    });
    const eligible = all.filter((a) => {
      const p = parseProcessing(a.processing);
      const e = p?.edits;
      const done = (a.processingResult as { batch?: string } | null)?.batch === "fix-crop";
      return p && !done && !e?.crop && !(e?.strokes?.length ?? 0);
    });
    assets.push(...eligible.filter((_, i) => i % shardN === shardK).slice(0, limit));
    console.log(`auto: ${all.length} photos from ${from}, ${eligible.length} eligible (no manual edits, not fixed before), this shard ${assets.length}`);
  }
  for (const t of targets) {
    const found = await db.photoAsset.findMany({
      where: { deletedAt: null, OR: [...(/^[0-9a-f-]{36}$/i.test(t) ? [{ id: t }] : []), { item: { inventoryNumber: t } }], imageState: { in: ["DONE", "NEEDS_REVIEW"] } },
      include: { files: true, item: { select: { inventoryNumber: true } } },
      orderBy: { createdAt: "asc" },
    }).catch(() => []);
    assets.push(...found);
  }
  console.log(`${assets.length} photos${apply ? " — WRITING" : " — preview only, nothing is written"}`);
  const cards: string[] = [];
  const snap: unknown[] = [];
  const log: { id: string; item: string | null; category: string; verdict: string; detail?: string }[] = [];
  const note = (a: (typeof assets)[number], verdict: string, detail?: string) => {
    log.push({ id: a.id, item: a.item?.inventoryNumber ?? null, category: a.category, verdict, detail });
    writeFileSync(path.join(REPORTS, `auto-${stamp}.json`), JSON.stringify(log, null, 1));
  };
  for (const a of assets) {
   try {
    const stored = parseProcessing(a.processing);
    const primary = a.files.find((f) => f.role === "PRIMARY" && f.uploadStatus === "VERIFIED");
    if (!stored || !primary) continue;
    const input = await storage().getBuffer(primary.storageKey);
    if (createHash("sha256").update(input).digest("hex") !== primary.sha256) {
      console.warn(a.id, "original checksum mismatch — skipped");
      continue;
    }
    const segOpts = { sensitivity: stored.settings.sensitivity, bgSample: stored.settings.bgSample };
    let rotation = stored.settings.rotation;
    let source = input;
    let w = await working(input, rotation);
    let seg = segmentBook({ data: w.data, width: w.w, height: w.h, channels: 3 }, segOpts);
    let crop = mainCrop(seg.mask, w.w, w.h);
    if (!crop) {
      console.warn(a.id, "no object found — skipped");
      continue;
    }
    if (auto) {
      if (crop.others > 0) {
        note(a, "composition", "several objects — left alone");
        continue;
      }
      // is the current result already a good crop of the main object? compare sizes at full resolution
      const meta = await sharp(input).metadata();
      let fw = (meta.orientation ?? 1) >= 5 ? meta.height! : meta.width!;
      let fh = (meta.orientation ?? 1) >= 5 ? meta.width! : meta.height!;
      if (residualRotation(meta.orientation, rotation as never) % 180 !== 0) [fw, fh] = [fh, fw];
      const scale = Math.max(fw, fh) / Math.max(w.w, w.h);
      const padPx = ((margin ?? stored.settings.marginPct) / 100) * Math.max(crop.w * w.w, crop.h * w.h);
      const expW = Math.min(w.w, crop.w * w.w + 2 * padPx) * scale;
      const expH = Math.min(w.h, crop.h * w.h + 2 * padPx) * scale;
      const curW = a.processedWidth ?? 0;
      const curH = a.processedHeight ?? 0;
      const off = (c: number, e: number) => c > e * 1.07 || c < e * 0.93;
      const bad = a.imageState === "NEEDS_REVIEW" || off(curW, expW) || off(curH, expH);
      if (!bad) {
        note(a, "good", `current ${curW}x${curH}, expected ~${Math.round(expW)}x${Math.round(expH)}`);
        continue;
      }
      if (detectOnly) {
        note(a, "bad", `${a.imageState} current ${curW}x${curH}, expected ~${Math.round(expW)}x${Math.round(expH)}`);
        continue;
      }
    }
    // straighten by the MAIN object's own tilt (the strip / other objects do not vote)
    let deskew: DeskewDecision = stored.settings.autoDeskew === false && flag("no-deskew") ? skipped("disabled") : decideDeskew(crop.mask, null, w.w, w.h);
    if (flag("no-deskew")) deskew = skipped("disabled");
    if (deskew.apply) {
      source = await straightened(input, rotation, deskew.angle, seg.model.rgb);
      rotation = 0;
      w = await working(source, 0);
      seg = segmentBook({ data: w.data, width: w.w, height: w.h, channels: 3 }, segOpts);
      const again = mainCrop(seg.mask, w.w, w.h);
      const check = again ? decideDeskew(again.mask, null, w.w, w.h) : null;
      if (!again || !check || Math.abs(check.tilt) > Math.max(0.6, Math.abs(deskew.tilt) * 0.4)) {
        // did not come out straighter: keep the original orientation
        source = input;
        rotation = stored.settings.rotation;
        deskew = { ...deskew, apply: false, angle: 0, skip: "not-verified" };
        w = await working(input, rotation);
        seg = segmentBook({ data: w.data, width: w.w, height: w.h, channels: 3 }, segOpts);
        crop = mainCrop(seg.mask, w.w, w.h)!;
      } else {
        crop = again;
      }
    }
    // a little air around the object (a % of its longer side), clamped to the picture
    const pad = ((margin ?? stored.settings.marginPct) / 100) * Math.max(crop.w * w.w, crop.h * w.h);
    const x0 = Math.max(0, crop.x - pad / w.w);
    const y0 = Math.max(0, crop.y - pad / w.h);
    const x1 = Math.min(1, crop.x + crop.w + pad / w.w);
    const y1 = Math.min(1, crop.y + crop.h + pad / w.h);
    const next = photoProcessingSchema.parse({
      settings: { ...stored.settings, rotation, autoDeskew: false },
      edits: { ...(stored.edits ?? {}), crop: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, confirmed: true },
    });
    const book = await processBook(source, next, "full");
    book.deskew = deskewInfo(deskew);
    const label = `${a.item?.inventoryNumber ?? ""} ${a.category} ${a.id.slice(0, 8)}`;
    console.log(label, `${a.processedWidth}x${a.processedHeight} -> ${book.width}x${book.height}`, deskew.apply ? `deskew ${deskew.angle}°` : `no deskew (${deskew.skip})`, `crop ${(x1 - x0).toFixed(2)}x${(y1 - y0).toFixed(2)} of the frame`);
    const small = (b: Buffer) => sharp(b).resize({ width: 560, height: 560, fit: "inside" }).flatten({ background: flattenColor(next) }).jpeg({ quality: 80 }).toBuffer();
    const before = a.processedKey ? await storage().getBuffer(a.processedKey).then(small, () => null) : null;
    const img = (b: Buffer | null) => (b ? `<img src="data:image/jpeg;base64,${b.toString("base64")}">` : "—");
    if (!auto || !apply) cards.push(`<section><h3>${label}</h3><div class=p><figure>${img(before)}<figcaption>לפני</figcaption></figure><figure>${img(await small(book.data))}<figcaption>אחרי</figcaption></figure></div></section>`);

    if (!apply) {
      if (auto) note(a, "would-fix", `${a.processedWidth}x${a.processedHeight} -> ${book.width}x${book.height}`);
      continue;
    }
    const tag = `fix${stamp.replace(/\D/g, "").slice(0, 12)}`;
    const nk = {
      processed: `orgs/${a.organizationId}/processed/${a.id}/book.${tag}.${book.ext}`,
      thumb: `orgs/${a.organizationId}/derived/${a.id}/thumb.${tag}.webp`,
      preview: `orgs/${a.organizationId}/derived/${a.id}/preview.${tag}.jpg`,
    };
    const { thumb, preview } = await deriveImages(book.data, flattenColor(stored));
    const s = storage();
    await s.putBuffer(nk.processed, book.data, book.mime);
    await s.putBuffer(nk.thumb, thumb, "image/webp");
    await s.putBuffer(nk.preview, preview, "image/jpeg");
    const back = await sharp(await s.getBuffer(nk.processed)).metadata();
    if (back.width !== book.width || back.height !== book.height) throw new Error(`verification failed for ${a.id}`);
    const previous = {
      processedKey: a.processedKey, processedMime: a.processedMime, processedWidth: a.processedWidth, processedHeight: a.processedHeight,
      thumbKey: a.thumbKey, previewKey: a.previewKey, imageState: a.imageState, processing: a.processing, processingResult: a.processingResult,
    };
    snap.push({ id: a.id, newKey: nk.processed, previous });
    writeFileSync(path.join(REPORTS, `rollback-${stamp}.json`), JSON.stringify(snap, null, 1)); // before the flip
    const r = await db.photoAsset.updateMany({
      where: { id: a.id, processedKey: a.processedKey },
      data: {
        processedKey: nk.processed, processedMime: book.mime, processedWidth: book.width, processedHeight: book.height,
        thumbKey: nk.thumb, previewKey: nk.preview, imageState: book.status,
        processingResult: { ...resultInfo(book, stored), batch: "fix-crop" } as object,
      },
    });
    console.log("  updated:", r.count === 1);
    note(a, r.count === 1 ? "fixed" : "changed-meanwhile", `${a.processedWidth}x${a.processedHeight} -> ${book.width}x${book.height}, ${deskew.apply ? `deskew ${deskew.angle}°` : `no deskew (${deskew.skip})`}`);
   } catch (e) {
    console.warn(a.id, "failed:", e instanceof Error ? e.message : e);
    note(a, "error", e instanceof Error ? e.message.slice(0, 200) : String(e));
   }
  }
  if (auto) {
    const count = (v: string) => log.filter((l) => l.verdict === v).length;
    console.log(`
summary: ${log.length} examined | good ${count("good")} | fixed ${count("fixed")} | would-fix ${count("would-fix")} | bad ${count("bad")} | composition ${count("composition")} | errors ${count("error")}`);
    if (apply && snap.length) console.log(`rollback: fix-crop --rollback ${path.join(REPORTS, `rollback-${stamp}.json`)}`);
    if (apply || detectOnly) return;
  }
  const html = `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>תיקון חיתוך</title><style>body{font-family:Segoe UI,Arial;background:#f4f4f2;margin:20px}section{background:#fff;border-radius:8px;padding:10px 14px;margin-bottom:14px}.p{display:flex;gap:10px;flex-wrap:wrap}figure{margin:0;text-align:center;flex:1 1 300px}img{max-width:100%;border:1px solid #ddd;background:repeating-conic-gradient(#eee 0 25%,#fff 0 50%) 0 0/16px 16px}</style><h1>תיקון חיתוך — ${apply ? "בוצע" : "תצוגה בלבד"}</h1>${cards.join("")}</html>`;
  const out = path.join(REPORTS, `fix-crop-${stamp}.html`);
  writeFileSync(out, html);
  console.log(`\nreport: ${out}`);
  if (apply && snap.length) console.log(`rollback: fix-crop --rollback ${path.join(REPORTS, `rollback-${stamp}.json`)}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
