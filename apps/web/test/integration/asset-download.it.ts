import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { inflateRawSync } from "node:zlib";
import { DEFAULT_PROCESSING } from "@avot/shared";
import { randomUUID, createHash } from "node:crypto";
import { db } from "@/server/db";
import { storage } from "@/server/storage";
import { registerCapture, uploadFileContent } from "@/server/services/captures";
import { finalizeProcessedAsset, reprocessAsset } from "@/server/services/book-processing";
import { serveAsset } from "@/server/services/asset-read";
import { runExportJob } from "@/server/services/exports";
import { downloadOptions } from "@/lib/asset-versions";
import { toAssetDto } from "@/server/services/asset-dto";
import { assetSelect } from "@/server/services/assets";
import type { UserPrincipal } from "@/server/auth/principal";
import { leatherFill, renderScene, roundedRect } from "../imaging-fixtures";

const hasDb = !!process.env.IT_DATABASE_URL;

async function greenShot(seed: number, w = 960, h = 640) {
  const bx = 280;
  const by = 60;
  const lf = leatherFill(bx, by);
  const scene = renderScene({ width: w, height: h, outline: roundedRect(bx, by, 380, 520, 14, 6), seed, bg: [120, 0.62, 0.55], fill: (x, y) => lf(x, y) });
  return sharp(Buffer.from(scene.rgb), { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 94, chromaSubsampling: "4:4:4" }).toBuffer();
}


/** reads a ZIP (stored or deflated entries) through its central directory: name → file bytes */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  // the exporter forces ZIP64: the end record points to the ZIP64 end record, entries keep sizes / offset in an extra field
  let count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const loc = eocd - 20;
  if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
    const z64 = Number(buf.readBigUInt64LE(loc + 8));
    count = Number(buf.readBigUInt64LE(z64 + 32));
    p = Number(buf.readBigUInt64LE(z64 + 48));
  }
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    let csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    // ZIP64 extra (id 1): the 32-bit fields that are 0xFFFFFFFF, in the order size, compressed size, offset
    for (let e = p + 46 + nameLen; e < p + 46 + nameLen + extraLen; ) {
      const id = buf.readUInt16LE(e);
      const len = buf.readUInt16LE(e + 2);
      if (id === 1) {
        let q = e + 4;
        if (usize === 0xffffffff) q += 8;
        if (csize === 0xffffffff) {
          csize = Number(buf.readBigUInt64LE(q));
          q += 8;
        }
        if (local === 0xffffffff) local = Number(buf.readBigUInt64LE(q));
      }
      e += 4 + len;
    }
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + csize);
    out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const bytesOf = async (res: Response) => Buffer.from(await res.arrayBuffer());

describe.skipIf(!hasDb)("downloading the processed and the original picture", () => {
  let user: UserPrincipal;
  let orgId: string;
  let itemId: string;
  let otherOrgUser: UserPrincipal;

  async function shoot(jpeg: Buffer) {
    const reg = await registerCapture(user, {
      captureId: randomUUID(),
      inventoryItemId: itemId,
      category: "COVER",
      source: "DIGICAMCONTROL",
      capturedAt: new Date().toISOString(),
      files: [{ role: "PRIMARY", originalFilename: "IMG_0001.JPG", mimeType: "image/jpeg", sizeBytes: jpeg.length, sha256: createHash("sha256").update(jpeg).digest("hex") }],
      processing: DEFAULT_PROCESSING,
    });
    await uploadFileContent(user, reg.files[0]!.fileId, new Response(new Uint8Array(jpeg)).body);
    for (let i = 0; i < 300; i++) {
      const a = await db.photoAsset.findUniqueOrThrow({ where: { id: reg.assetId }, select: { imageState: true, processingStatus: true } });
      if (a.imageState !== "QUEUED" && a.processingStatus !== "PENDING") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return reg.assetId;
  }

  beforeAll(async () => {
    const mk = async (tag: string) => {
      const org = await db.organization.create({ data: { name: `IT dl ${tag}`, slug: `it-dl-${tag}-${Date.now()}` } });
      const u = await db.user.create({ data: { organizationId: org.id, email: `dl-${tag}-${Date.now()}@example.test`, name: "IT", role: "ADMIN" } });
      return { org, principal: { kind: "user", userId: u.id, organizationId: org.id, role: "ADMIN", name: "IT", email: u.email } as unknown as UserPrincipal };
    };
    const a = await mk("a");
    const b = await mk("b");
    orgId = a.org.id;
    user = a.principal;
    otherOrgUser = b.principal;
    itemId = (await db.inventoryItem.create({ data: { organizationId: orgId, serial: 1, inventoryNumber: "ITM-DL1", barcode: "ITM-DL1", title: "Download book", requirements: {} } })).id;
  });

  it("a processed download is refused until the full file is final; the original is always available and byte-identical", async () => {
    const jpeg = await greenShot(21);
    const id = await shoot(jpeg);
    expect((await db.photoAsset.findUniqueOrThrow({ where: { id } })).imageState).toBe("PREVIEW_READY");

    // no silent fallback to the original
    await expect(serveAsset(orgId, id, "processed", { download: true })).rejects.toMatchObject({ code: "CONFLICT", message: "התמונה המעובדת עדיין אינה מוכנה להורדה." });

    const orig = await serveAsset(orgId, id, "original", { download: true });
    expect(orig.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(orig.headers.get("cache-control")).toContain("no-store");
    expect((await bytesOf(orig)).equals(jpeg)).toBe(true);

    // what the UI offers while pending: the original only, with an explanation for the processed one
    const dto = toAssetDto((await db.photoAsset.findUniqueOrThrow({ where: { id }, select: assetSelect })) as never);
    const opts = downloadOptions(dto);
    expect(opts.primary).toBeNull();
    expect(opts.processed).toBeNull();
    expect(opts.processedMessage).toBe("התמונה המעובדת עדיין אינה מוכנה להורדה.");
    expect(opts.original.href).toContain(`/api/assets/${id}/original?download=1`);
  });

  it("the downloaded processed file is the full stored file: same bytes, same size, same type", async () => {
    const id = await shoot(await greenShot(22));
    await finalizeProcessedAsset(id);
    const a = await db.photoAsset.findUniqueOrThrow({ where: { id } });
    expect(a.imageState).toBe("DONE");

    const res = await serveAsset(orgId, id, "processed", { download: true });
    const got = await bytesOf(res);
    const stored = await storage().getBuffer(a.processedKey!);
    expect(got.equals(stored)).toBe(true); // no resize, no re-compression
    const meta = await sharp(got).metadata();
    expect(meta.width).toBe(a.processedWidth);
    expect(meta.height).toBe(a.processedHeight);
    expect(res.headers.get("content-type")).toBe(a.processedMime);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("content-disposition")).toContain("ITM-DL1");
    // it is not the thumbnail / preview
    expect(got.length).toBeGreaterThan((await storage().getBuffer(a.previewKey!)).length);

    const dto = toAssetDto((await db.photoAsset.findUniqueOrThrow({ where: { id }, select: assetSelect })) as never);
    const opts = downloadOptions(dto);
    expect(opts.primary?.kind).toBe("processed");
    expect(opts.primary?.href).toContain(`/api/assets/${id}/processed?download=1`);
    expect(opts.raw).toBeNull();
    // a photo with no RAW file: asking for it is a 404, not the JPEG
    await expect(serveAsset(orgId, id, "original", { role: "RAW", download: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("after a re-edit the download is the new result, and stale while it is being reprocessed", async () => {
    const id = await shoot(await greenShot(23));
    await finalizeProcessedAsset(id);
    const before = await bytesOf(await serveAsset(orgId, id, "processed", { download: true }));
    const beforeMeta = await sharp(before).metadata();

    const r = await reprocessAsset(user, id, { edits: { crop: { x: 0.25, y: 0.05, w: 0.5, h: 0.9 } }, settings: { rotation: 0, marginPct: 0 } });
    expect(r.imageState).toBe("PREVIEW_READY");
    await expect(serveAsset(orgId, id, "processed", { download: true })).rejects.toMatchObject({ code: "CONFLICT" }); // the old file is not handed out as the new one

    await finalizeProcessedAsset(id);
    const after = await bytesOf(await serveAsset(orgId, id, "processed", { download: true }));
    const afterMeta = await sharp(after).metadata();
    const row = await db.photoAsset.findUniqueOrThrow({ where: { id } });
    expect(afterMeta.width).toBe(row.processedWidth);
    expect(afterMeta.height).toBe(row.processedHeight);
    expect(after.equals(before)).toBe(false);
    expect(`${afterMeta.width}x${afterMeta.height}`).not.toBe(`${beforeMeta.width}x${beforeMeta.height}`);
  });

  it("another organization cannot download it", async () => {
    const id = await shoot(await greenShot(24));
    await finalizeProcessedAsset(id);
    await expect(serveAsset(otherOrgUser.organizationId, id, "processed", { download: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(serveAsset(otherOrgUser.organizationId, id, "original", { download: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("ZIP: processed export carries the same full files; an unprocessed photo is included as a marked original and reported", async () => {
    const ready = await shoot(await greenShot(25));
    await finalizeProcessedAsset(ready);
    const pending = await shoot(await greenShot(26));
    await db.photoAsset.update({ where: { id: pending }, data: { imageState: "QUEUED" } }); // being processed: no final file yet
    const readyRow = await db.photoAsset.findUniqueOrThrow({ where: { id: ready } });
    const processedBytes = await storage().getBuffer(readyRow.processedKey!);
    const pendingOriginal = await storage().getBuffer((await db.photoFile.findFirstOrThrow({ where: { assetId: pending, role: "PRIMARY" } })).storageKey);

    const job = await db.job.create({
      data: { organizationId: orgId, type: "EXPORT_ZIP", status: "RUNNING", payload: { scope: "selection", assetIds: [ready, pending], variant: "processed", includeRaw: true, maxSize: 3000, readableFolders: false } },
    });
    await runExportJob(job);
    const done = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    const zip = await storage().getBuffer(done.resultKey!);
    const files = unzip(zip);
    const names = [...files.keys()];
    const processedEntry = names.find((n) => /L001-cover-001\.jpg$/.test(n))!;
    const markedEntry = names.find((n) => n.endsWith("-ORIGINAL-NOT-PROCESSED.jpg"))!;
    // the very bytes of the full processed file, untouched; the unprocessed photo is its marked original, not passed off as processed
    expect(files.get(processedEntry)!.equals(processedBytes)).toBe(true);
    expect(files.get(markedEntry)!.equals(pendingOriginal)).toBe(true);
    expect(names.some((n) => n.endsWith("NOT-PROCESSED.txt"))).toBe(true);
    expect(files.get(names.find((n) => n.endsWith("manifest.csv"))!)!.toString("utf8")).toContain("original (no processed file)");

    // original export: both are the originals, nothing marked
    const job2 = await db.job.create({
      data: { organizationId: orgId, type: "EXPORT_ZIP", status: "RUNNING", payload: { scope: "selection", assetIds: [ready], variant: "original", includeRaw: true, maxSize: 3000, readableFolders: false } },
    });
    await runExportJob(job2);
    const files2 = unzip(await storage().getBuffer((await db.job.findUniqueOrThrow({ where: { id: job2.id } })).resultKey!));
    const only = [...files2.entries()].find(([n]) => /\.jpg$/.test(n))!;
    expect(only[1].equals(processedBytes)).toBe(false); // the original, not the processed file
    expect([...files2.keys()].some((n) => n.includes("NOT-PROCESSED"))).toBe(false);
  });
});
