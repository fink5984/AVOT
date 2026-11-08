import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { randomUUID, createHash } from "node:crypto";
import { DEFAULT_PROCESSING, type ProcessingSettings } from "@avot/shared";
import { db } from "@/server/db";
import { storage } from "@/server/storage";
import { registerCapture, uploadFileContent } from "@/server/services/captures";
import { finalizeProcessedAsset } from "@/server/services/book-processing";
import { batchProgress, examineAll, planBatch, rollbackBatch, runBatch } from "@/server/services/deskew-batch";
import type { UserPrincipal } from "@/server/auth/principal";
import { leatherFill, renderScene, roundedRect, type Poly } from "../imaging-fixtures";

const hasDb = !!process.env.IT_DATABASE_URL;

const rot = (p: Poly, cx: number, cy: number, deg: number): Poly => {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return p.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]);
};

/** a 1600×1100 shot with a book (tilted by `tilt`°) or several books on the green table */
async function shot(books: { tilt: number; x: number }[]) {
  const w = 1600;
  const h = 1100;
  const first = books[0]!;
  const mk = (b: { tilt: number; x: number }) => rot(roundedRect(b.x, 200, 360, 700, 16, 6), b.x + 180, 550, b.tilt);
  const base = renderScene({ width: w, height: h, outline: mk(first), fill: leatherFill(first.x, 200) });
  for (const b of books.slice(1)) {
    const layer = renderScene({ width: w, height: h, outline: mk(b), fill: leatherFill(b.x, 200), noise: 0 });
    for (let i = 0; i < layer.truth.length; i++) if (layer.truth[i]) base.rgb.set(layer.rgb.subarray(i * 3, i * 3 + 3), i * 3);
  }
  return sharp(Buffer.from(base.rgb), { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
}

describe.skipIf(!hasDb)("straightening existing photos: dry run, batch, resume, rollback", () => {
  let user: UserPrincipal;
  let orgId: string;
  let itemId: string;
  const made: Record<string, string> = {};

  /** an "existing" photo: captured and processed before auto deskew existed (switch off in its settings) */
  async function existing(name: string, jpeg: Buffer) {
    const captureId = randomUUID();
    const settings: ProcessingSettings = { ...DEFAULT_PROCESSING, rotation: 0, autoDeskew: false, marginPct: 0 };
    const reg = await registerCapture(user, {
      captureId,
      inventoryItemId: itemId,
      category: "COVER",
      source: "DIGICAMCONTROL",
      capturedAt: new Date().toISOString(),
      files: [{ role: "PRIMARY", originalFilename: `${name}.JPG`, mimeType: "image/jpeg", sizeBytes: jpeg.length, sha256: createHash("sha256").update(jpeg).digest("hex") }],
      processing: settings,
    });
    await uploadFileContent(user, reg.files[0]!.fileId, new Response(new Uint8Array(jpeg)).body);
    for (let i = 0; i < 300; i++) {
      const a = await db.photoAsset.findUniqueOrThrow({ where: { id: reg.assetId }, select: { imageState: true, processingStatus: true } });
      if (a.imageState !== "QUEUED" && a.processingStatus !== "PENDING") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await finalizeProcessedAsset(reg.assetId);
    made[name] = reg.assetId;
    return reg.assetId;
  }

  beforeAll(async () => {
    const org = await db.organization.create({ data: { name: "IT deskew", slug: `it-dsk-${Date.now()}` } });
    orgId = org.id;
    const u = await db.user.create({ data: { organizationId: orgId, email: `it-dsk-${Date.now()}@example.test`, name: "IT", role: "ADMIN" } });
    user = { kind: "user", userId: u.id, organizationId: orgId, role: "ADMIN", name: "IT", email: u.email } as unknown as UserPrincipal;
    const item = await db.inventoryItem.create({ data: { organizationId: orgId, serial: 1, inventoryNumber: "DSK-1", barcode: "DSK-1", title: "Deskew", requirements: {} } });
    itemId = item.id;
    await existing("tilted", await shot([{ tilt: 4, x: 600 }]));
    await existing("straight", await shot([{ tilt: 0, x: 600 }]));
    await existing("composition", await shot([{ tilt: 10, x: 250 }, { tilt: -7, x: 700 }, { tilt: 3, x: 1150 }]));
    const manual = await existing("manual", await shot([{ tilt: 4, x: 600 }]));
    const row = await db.photoAsset.findUniqueOrThrow({ where: { id: manual } });
    const p = row.processing as { settings: object; edits?: object };
    await db.photoAsset.update({ where: { id: manual }, data: { processing: { ...p, edits: { crop: { x: 0.2, y: 0.1, w: 0.6, h: 0.8 }, confirmed: true } } } });
  });

  const snapshot = async (id: string) => db.photoAsset.findUniqueOrThrow({ where: { id }, include: { files: true } });

  it("dry run classifies every photo and writes nothing", async () => {
    const before = await Promise.all(Object.values(made).map(snapshot));
    const rows = await examineAll(orgId);
    const by = Object.fromEntries(rows.map((r) => [r.assetId, r]));
    expect(by[made.tilted!]!.verdict).toBe("can-straighten");
    expect(Math.abs(by[made.tilted!]!.angle + 4)).toBeLessThan(0.4);
    expect(by[made.straight!]!.verdict).toBe("already-straight");
    expect(by[made.composition!]!.verdict).toBe("composition");
    expect(by[made.manual!]!.verdict).toBe("manual-edits");
    const after = await Promise.all(Object.values(made).map(snapshot));
    expect(after).toEqual(before);
    expect(await db.deskewBatch.count({ where: { organizationId: orgId } })).toBe(0);
  });

  let batchId: string;
  let tiltedBefore: Awaited<ReturnType<typeof snapshot>>;
  let originalSha: string;

  it("a batch straightens in small steps, resumes after a stop, and writes new files without touching old ones", async () => {
    tiltedBefore = await snapshot(made.tilted!);
    originalSha = tiltedBefore.files[0]!.sha256;
    const planned = await planBatch(orgId);
    batchId = planned.batch.id;
    expect(planned.planned).toBe(3); // tilted, straight, composition
    expect(planned.preSkipped).toBe(1); // the manual crop

    const first = await runBatch(batchId, { maxItems: 1 }); // "stop" after one photo
    expect(first.status).toBe("RUNNING");
    expect(first.pending).toBe(2);
    // crash simulation: an item is left PROCESSING with no flip → it must go back to the queue, not be lost or doubled
    const pending = await db.deskewBatchItem.findFirstOrThrow({ where: { batchId, status: "PENDING" } });
    await db.deskewBatchItem.update({ where: { id: pending.id }, data: { status: "PROCESSING", attempts: 1 } });

    const done = await runBatch(batchId, { pauseMs: 0 });
    expect(done.status).toBe("COMPLETED");
    expect(done.failed).toBe(0);
    expect(done.applied).toBe(1);
    expect(done.skipped).toBe(3);

    const after = await snapshot(made.tilted!);
    expect(after.processedKey).not.toBe(tiltedBefore.processedKey);
    expect(after.processedKey).toContain("dsk");
    expect(after.thumbKey).not.toBe(tiltedBefore.thumbKey);
    // the new file is readable, of the recorded size and straighter (an upright 360×700 cover)
    const meta = await sharp(await storage().getBuffer(after.processedKey!)).metadata();
    expect(meta.width).toBe(after.processedWidth);
    expect(meta.height).toBe(after.processedHeight);
    expect(Math.abs(after.processedWidth! - 360)).toBeLessThanOrEqual(8);
    expect(Math.abs(after.processedHeight! - 700)).toBeLessThanOrEqual(8);
    expect(after.processedWidth).toBeLessThan(tiltedBefore.processedWidth!);
    expect((after.processingResult as { deskew: { applied: boolean }; at: number }).deskew.applied).toBe(true);
    expect((after.processingResult as { at: number }).at).toBeGreaterThan((tiltedBefore.processingResult as { at: number }).at); // the page's cache key changes
    // the previous version is still in storage; the original is byte-identical
    expect(await storage().exists(tiltedBefore.processedKey!)).toBe(true);
    expect(createHash("sha256").update(await storage().getBuffer(after.files[0]!.storageKey)).digest("hex")).toBe(originalSha);

    // the others are untouched
    for (const name of ["straight", "composition", "manual"]) {
      const a = await snapshot(made[name]!);
      expect(a.processedKey).not.toContain("dsk");
    }
    const items = await db.deskewBatchItem.findMany({ where: { batchId } });
    expect(items.find((i) => i.assetId === made.straight)!.skipReason).toBe("already-straight");
    expect(items.find((i) => i.assetId === made.composition)!.skipReason).toMatch(/multiple-objects|mixed-directions/);
    expect(items.find((i) => i.assetId === made.manual)!.skipReason).toBe("manual-edits");
  });

  it("running again does nothing for photos already handled by this algorithm version", async () => {
    const again = await planBatch(orgId);
    expect(again.planned).toBe(0);
    const p = await runBatch(again.batch.id);
    expect(p.total).toBe(0); // nothing new to examine, nothing processed twice
    expect((await snapshot(made.tilted!)).processedKey).toContain("dsk");
  });

  it("an interrupted write never replaces anything: a failing original is reported, not half-applied", async () => {
    const id = await existing("broken", await shot([{ tilt: 5, x: 600 }]));
    const file = (await snapshot(id)).files[0]!;
    const before = await snapshot(id);
    await db.photoFile.update({ where: { id: file.id }, data: { sha256: "0".repeat(64) } }); // checksum no longer matches the stored bytes
    const planned = await planBatch(orgId);
    const p = await runBatch(planned.batch.id);
    expect(p.failed).toBe(1);
    const after = await snapshot(id);
    expect(after.processedKey).toBe(before.processedKey);
    expect(after.processingResult).toEqual(before.processingResult);
    const item = await db.deskewBatchItem.findFirstOrThrow({ where: { batchId: planned.batch.id, assetId: id } });
    expect(item.error).toMatch(/checksum/);
    await db.photoFile.update({ where: { id: file.id }, data: { sha256: before.files[0]!.sha256 } });
    await db.photoAsset.update({ where: { id }, data: { deletedAt: new Date() } }); // out of the way of the following steps
  });

  it("rollback restores the previous processed version without any re-upload", async () => {
    const r = await rollbackBatch(batchId);
    expect(r.restored).toBe(1);
    expect(r.notRestored).toEqual([]);
    const a = await snapshot(made.tilted!);
    expect(a.processedKey).toBe(tiltedBefore.processedKey);
    expect(a.processedWidth).toBe(tiltedBefore.processedWidth);
    expect(a.processedHeight).toBe(tiltedBefore.processedHeight);
    expect(a.thumbKey).toBe(tiltedBefore.thumbKey);
    expect(a.previewKey).toBe(tiltedBefore.previewKey);
    expect(a.imageState).toBe(tiltedBefore.imageState);
    expect(a.processingResult).toEqual(tiltedBefore.processingResult);
    expect((await batchProgress(batchId)).status).toBe("ROLLED_BACK");
    // a rolled-back photo is not straightened again by accident…
    expect((await planBatch(orgId)).planned).toBe(0);
    // …only on an explicit forced re-run, which starts again from the original
    const forced = await planBatch(orgId, { force: true });
    expect(forced.planned).toBeGreaterThan(0);
  });

  it("a photo edited after the batch is not overwritten by the rollback", async () => {
    const forced = await db.deskewBatch.findFirstOrThrow({ where: { organizationId: orgId, params: { path: ["force"], equals: true } } });
    await runBatch(forced.id);
    const applied = await snapshot(made.tilted!);
    expect(applied.processedKey).toContain("dsk");
    await db.photoAsset.update({ where: { id: made.tilted! }, data: { processedKey: "orgs/x/processed/manual-edit.png" } }); // a later manual correction wrote its own file
    const r = await rollbackBatch(forced.id);
    expect(r.notRestored.some((n) => n.assetId === made.tilted)).toBe(true);
    expect((await snapshot(made.tilted!)).processedKey).toBe("orgs/x/processed/manual-edit.png");
  });
});
