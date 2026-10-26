import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { randomUUID, createHash } from "node:crypto";
import { DEFAULT_PROCESSING, type ProcessingSettings } from "@avot/shared";
import { db } from "@/server/db";
import { storage } from "@/server/storage";
import { registerCapture, uploadFileContent } from "@/server/services/captures";
import { createProfile, defaultProcessing, deleteProfile, listProfiles, updateProfile } from "@/server/services/camera-profiles";
import { finalizeProcessedAsset, reprocessAsset } from "@/server/services/book-processing";
import { toAssetDto } from "@/server/services/asset-dto";
import { assetSelect, softDeleteAssets, purgeExpiredTrash } from "@/server/services/assets";
import type { UserPrincipal } from "@/server/auth/principal";
import { leatherFill, renderScene, roundedRect } from "../imaging-fixtures";

const hasDb = !!process.env.IT_DATABASE_URL;

async function jpegOf(id: number, w = 960, h = 640, bg: [number, number, number] = [120, 0.62, 0.55]) {
  const bx = 280;
  const by = 60;
  const lf = leatherFill(bx, by);
  const scene = renderScene({
    width: w,
    height: h,
    outline: roundedRect(bx, by, 380, 520, 14, 6),
    seed: id,
    bg,
    fill: (x, y) => {
      if (y > by + 20 && y < by + 60 && x > bx + 20 && x < bx + 20 + 5 * 50) return (id >> Math.floor((x - bx - 20) / 50)) & 1 ? [250, 250, 250] : [10, 10, 10];
      return lf(x, y);
    },
  });
  return sharp(Buffer.from(scene.rgb), { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 94, chromaSubsampling: "4:4:4" }).toBuffer();
}

describe.skipIf(!hasDb)("green-screen processing against a real database", () => {
  let user: UserPrincipal;
  let orgId: string;
  const items: string[] = [];

  async function shoot(itemId: string, category: "COVER" | "INTERIOR", jpeg: Buffer, processing?: ProcessingSettings, source: "SIMULATOR" | "DIGICAMCONTROL" = "DIGICAMCONTROL") {
    const captureId = randomUUID();
    const reg = await registerCapture(user, {
      captureId,
      inventoryItemId: itemId,
      category,
      source,
      capturedAt: new Date().toISOString(),
      files: [{ role: "PRIMARY", originalFilename: "IMG_0001.JPG", mimeType: "image/jpeg", sizeBytes: jpeg.length, sha256: createHash("sha256").update(jpeg).digest("hex") }],
      processing,
    });
    await uploadFileContent(user, reg.files[0]!.fileId, new Response(new Uint8Array(jpeg)).body);
    // the green-screen preview runs beside the upload response; wait until it has landed
    for (let i = 0; i < 300; i++) {
      const a = await db.photoAsset.findUniqueOrThrow({ where: { id: reg.assetId }, select: { imageState: true, processingStatus: true } });
      if (a.imageState !== "QUEUED" && a.processingStatus !== "PENDING") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { captureId, assetId: reg.assetId };
  }

  beforeAll(async () => {
    const org = await db.organization.create({ data: { name: "IT org", slug: `it-${Date.now()}` } });
    orgId = org.id;
    const u = await db.user.create({ data: { organizationId: orgId, email: `it-${Date.now()}@example.test`, name: "IT", role: "ADMIN" } });
    user = { kind: "user", userId: u.id, organizationId: orgId, role: "ADMIN", name: "IT", email: u.email } as unknown as UserPrincipal;
    for (let i = 1; i <= 3; i++) {
      const it = await db.inventoryItem.create({
        data: { organizationId: orgId, serial: i, inventoryNumber: `ITM-T${i}`, barcode: `ITM-T${i}`, title: `Book ${i}`, requirements: {} },
      });
      items.push(it.id);
    }
  });

  it("camera profiles: default is created on first use, only one default, default cannot be deleted", async () => {
    const first = await listProfiles(orgId);
    expect(first).toHaveLength(1);
    expect(first[0]!.isDefault).toBe(true);
    expect(first[0]!.settings.processing.rotation).toBe(180);

    const other = await createProfile(user, { name: "Narrow books", settings: { processing: { ...DEFAULT_PROCESSING, marginPct: 6 }, camera: { iso: "400" } } });
    await updateProfile(user, other.id, { isDefault: true });
    const after = await listProfiles(orgId);
    expect(after.filter((p) => p.isDefault)).toHaveLength(1);
    expect((await defaultProcessing(orgId))?.marginPct).toBe(6);
    await expect(deleteProfile(user, other.id)).rejects.toThrow();
    await expect(createProfile(user, { name: "Narrow books", settings: { processing: DEFAULT_PROCESSING, camera: {} } })).rejects.toThrow();
    // back to the first as default so later tests use the stock settings
    await updateProfile(user, first[0]!.id, { isDefault: true });
    await deleteProfile(user, other.id);
  });

  it("capture → preview right after upload → full resolution in the background; original untouched", async () => {
    const jpeg = await jpegOf(5);
    const { assetId } = await shoot(items[0]!, "COVER", jpeg);

    let a = await db.photoAsset.findUniqueOrThrow({ where: { id: assetId }, include: { files: true } });
    expect(a.imageState).toBe("PREVIEW_READY");
    expect(a.thumbKey).toBeTruthy();
    const settings = (a.processing as { settings: ProcessingSettings }).settings;
    expect(settings.rotation).toBe(180); // frozen with the shot
    const queued = await db.job.findMany({ where: { type: "PROCESS_FINAL", status: "QUEUED", payload: { path: ["assetId"], equals: assetId } } });
    expect(queued).toHaveLength(1);

    await finalizeProcessedAsset(assetId);
    a = await db.photoAsset.findUniqueOrThrow({ where: { id: assetId }, include: { files: true } });
    expect(a.imageState).toBe("DONE");
    expect(a.processedKey).toBeTruthy();
    expect(Math.abs(a.processedWidth! - (380 + 2 * Math.round(0.02 * 520)))).toBeLessThan(6); // book + 2 % margin
    // idempotent: running the job again changes nothing
    await finalizeProcessedAsset(assetId);

    // the original is byte-identical to what was uploaded
    const stored = await storage().getBuffer(a.files[0]!.storageKey);
    expect(createHash("sha256").update(stored).digest("hex")).toBe(a.files[0]!.sha256);
    expect(a.files[0]!.sha256).toBe(createHash("sha256").update(jpeg).digest("hex"));

    const dto = toAssetDto((await db.photoAsset.findUniqueOrThrow({ where: { id: assetId }, select: assetSelect })) as never);
    expect(dto.processed?.state).toBe("DONE");
    expect(dto.processed?.hasFile).toBe(true);
    expect(dto.previewUrl).toContain("?v=DONE");
  });

  it("detection failure keeps the original, flags the photo and never crops", async () => {
    const { assetId } = await shoot(items[0]!, "INTERIOR", await jpegOf(9, 960, 640, [30, 0.04, 0.5]));
    await finalizeProcessedAsset(assetId);
    const a = await db.photoAsset.findUniqueOrThrow({ where: { id: assetId } });
    expect(a.imageState).toBe("NEEDS_REVIEW");
    expect(a.processedWidth).toBe(960);
    expect(a.processedHeight).toBe(640);
    expect((a.processingResult as { warnings: string[] }).warnings.length).toBeGreaterThan(0);
  });

  it("manual correction: confirm + crop, then restore the original", async () => {
    const { assetId } = await shoot(items[1]!, "COVER", await jpegOf(11, 960, 640, [30, 0.04, 0.5]));
    const fixed = await reprocessAsset(user, assetId, { edits: { crop: { x: 0.25, y: 0.05, w: 0.5, h: 0.9 } }, settings: { rotation: 0, marginPct: 0 } });
    expect(fixed.imageState).toBe("PREVIEW_READY");
    await finalizeProcessedAsset(assetId);
    const done = await db.photoAsset.findUniqueOrThrow({ where: { id: assetId } });
    expect(done.imageState).toBe("DONE");
    expect([done.processedWidth, done.processedHeight]).toEqual([480, 576]);

    const restored = await reprocessAsset(user, assetId, { restore: true });
    expect(restored.imageState).toBe("NONE");
    expect(restored.processedKey).toBeNull();
    expect(restored.thumbKey).toBeTruthy(); // plain derivatives of the original are back
    expect(await storage().exists(done.processedKey!)).toBe(false);
  });

  it("a stale background job never overwrites a newer manual correction", async () => {
    const { assetId } = await shoot(items[1]!, "INTERIOR", await jpegOf(13));
    await reprocessAsset(user, assetId, { settings: { marginPct: 10 } });
    await finalizeProcessedAsset(assetId);
    const a = await db.photoAsset.findUniqueOrThrow({ where: { id: assetId } });
    expect(((a.processing as { settings: ProcessingSettings }).settings.marginPct)).toBe(10);
    expect(a.processedWidth!).toBeGreaterThan(380 + 2 * 50);
  });

  it("20 captures in a row across 3 books: every photo stays with its book, category, sequence and marker", async () => {
    const plan = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, item: items[i % 3]!, category: (i % 2 ? "INTERIOR" : "COVER") as "COVER" | "INTERIOR" }));
    const results: { id: number; item: string; category: string; assetId: string }[] = [];
    for (const p of plan) {
      const { assetId } = await shoot(p.item, p.category, await jpegOf(p.id, 640, 440));
      results.push({ ...p, assetId });
    }
    for (const r of results) await finalizeProcessedAsset(r.assetId);

    for (const r of results) {
      const a = await db.photoAsset.findUniqueOrThrow({ where: { id: r.assetId } });
      expect(a.inventoryItemId).toBe(r.item);
      expect(a.category).toBe(r.category);
      expect(["DONE", "PREVIEW_READY"]).toContain(a.imageState);
      // decode the marker from the processed file: 5 squares near the top of the (180°-rotated) book
      const buf = await storage().getBuffer(a.processedKey!);
      const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
      // after 180° the marker row is near the bottom: mirror both axes
      const marginPx = Math.round(0.02 * 520);
      const y = info.height - 1 - (marginPx + 40);
      let decoded = 0;
      for (let bit = 0; bit < 5; bit++) {
        const x = info.width - 1 - (marginPx + 20 + bit * 50 + 25);
        const v = data[(y * info.width + x) * info.channels]!;
        if (v > 128) decoded |= 1 << bit;
      }
      expect(decoded).toBe(r.id);
    }
    for (const itemId of items) {
      const seqs = (await db.photoAsset.findMany({ where: { inventoryItemId: itemId }, select: { sequence: true } })).map((s) => s.sequence);
      expect(new Set(seqs).size).toBe(seqs.length);
    }
  });

  it("deleting and purging a photo removes the processed file as well", async () => {
    const { assetId } = await shoot(items[2]!, "COVER", await jpegOf(3, 640, 440));
    await finalizeProcessedAsset(assetId);
    const a = await db.photoAsset.findUniqueOrThrow({ where: { id: assetId } });
    await softDeleteAssets(user, [assetId]);
    await db.photoAsset.update({ where: { id: assetId }, data: { deletedAt: new Date(Date.now() - 90 * 864e5) } });
    await purgeExpiredTrash(orgId, 30);
    expect(await storage().exists(a.processedKey!)).toBe(false);
    expect(await db.photoAsset.findUnique({ where: { id: assetId } })).toBeNull();
  });
});
