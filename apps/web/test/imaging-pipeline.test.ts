import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { WORKING_LONG_EDGE, processBook } from "@/server/services/book-image";
import { DEFAULT_PROCESSING, photoProcessingSchema, type PhotoProcessing } from "@/lib/imaging/settings";
import { leatherFill, renderScene, roundedRect, type Scene } from "./imaging-fixtures";

const settings = (over: Partial<PhotoProcessing["settings"]> = {}, edits?: PhotoProcessing["edits"]): PhotoProcessing =>
  photoProcessingSchema.parse({ settings: { ...DEFAULT_PROCESSING, ...over }, edits });

async function jpeg(scene: Scene, orientation?: number): Promise<Buffer> {
  let p = sharp(Buffer.from(scene.rgb), { raw: { width: scene.width, height: scene.height, channels: 3 } }).jpeg({ quality: 95, chromaSubsampling: "4:4:4" });
  if (orientation) p = p.withMetadata({ orientation });
  return p.toBuffer();
}

async function pixels(buf: Buffer) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, c: info.channels };
}

/** book with a red square marker near its top-left corner */
function markedScene(w: number, h: number, bx: number, by: number, bw: number, bh: number, extra: Partial<Parameters<typeof renderScene>[0]> = {}) {
  const lf = leatherFill(bx, by);
  return renderScene({
    width: w,
    height: h,
    outline: roundedRect(bx, by, bw, bh, 18, 6),
    fill: (x, y) => (x > bx + 30 && x < bx + 110 && y > by + 30 && y < by + 110 ? [220, 20, 20] : lf(x, y)),
    ...extra,
  });
}

describe("processBook — orientation, crop and background removal at the original resolution", () => {
  const W = 2400;
  const H = 1600;
  const book = { x: 700, y: 250, w: 800, h: 1100 };
  const scene = markedScene(W, H, book.x, book.y, book.w, book.h);

  it("crops to the book at full resolution (±3 px) and removes the green", async () => {
    const input = await jpeg(scene);
    const r = await processBook(input, settings({ rotation: 0, marginPct: 0, background: "transparent" }), "full");
    expect(r.status).toBe("DONE");
    expect(r.mime).toBe("image/png");
    expect(Math.abs(r.width - book.w)).toBeLessThanOrEqual(3);
    expect(Math.abs(r.height - book.h)).toBeLessThanOrEqual(3);

    const { data, w, h, c } = await pixels(r.data);
    expect(c).toBe(4);
    // corner is outside the rounded cover → transparent; centre is opaque
    expect(data[3]).toBeLessThan(40);
    expect(data[((h >> 1) * w + (w >> 1)) * 4 + 3]).toBe(255);
    // no green halo: opaque or semi-opaque pixels must not lean green
    let edgePx = 0;
    let green = 0;
    for (let i = 0; i < w * h; i++) {
      const a = data[i * 4 + 3]!;
      if (a === 0) continue;
      const R = data[i * 4]!, G = data[i * 4 + 1]!, B = data[i * 4 + 2]!;
      if (a < 255) edgePx++;
      if (G > Math.max(R, B) + 18) green++;
    }
    expect(edgePx).toBeGreaterThan(100);
    expect(green / (w * h)).toBeLessThan(0.001);
  });

  it("default output: white background JPEG, rotation 180 puts the marker at the opposite corner", async () => {
    const input = await jpeg(scene);
    const plain = await processBook(input, settings({ rotation: 0, marginPct: 0 }), "full");
    const turned = await processBook(input, settings({ rotation: 180, marginPct: 0 }), "full");
    expect(plain.mime).toBe("image/jpeg");
    expect(Math.abs(turned.width - plain.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(turned.height - plain.height)).toBeLessThanOrEqual(2);
    const a = await pixels(plain.data);
    const b = await pixels(turned.data);
    const isRed = (p: typeof a, x: number, y: number) => {
      const o = (y * p.w + x) * p.c;
      return p.data[o]! > 180 && p.data[o + 1]! < 80 && p.data[o + 2]! < 80;
    };
    expect(isRed(a, 70, 70)).toBe(true); // top-left in the sensor orientation
    expect(isRed(b, b.w - 71, b.h - 71)).toBe(true); // bottom-right after 180°
    expect(isRed(b, 70, 70)).toBe(false);
  });

  it("an EXIF-rotated original is not rotated twice", async () => {
    const withExif = await jpeg(scene, 3); // pixels untouched, tag says "rotate 180"
    const without = await jpeg(scene);
    const a = await processBook(withExif, settings({ rotation: 180, marginPct: 0 }), "full");
    const b = await processBook(without, settings({ rotation: 180, marginPct: 0 }), "full");
    const pa = await pixels(a.data);
    const pb = await pixels(b.data);
    expect([pa.w, pa.h]).toEqual([pb.w, pb.h]);
    let diff = 0;
    for (let i = 0; i < pa.data.length; i += 97) diff += Math.abs(pa.data[i]! - pb.data[i]!);
    expect(diff / (pa.data.length / 97)).toBeLessThan(3);
  });

  it("JPEG on a custom background colour with margin", async () => {
    const input = await jpeg(scene);
    const r = await processBook(input, settings({ rotation: 0, marginPct: 5, background: "#ff00ff" }), "full");
    const p = await pixels(r.data);
    expect(r.height).toBeGreaterThan(book.h + 80);
    expect(p.data[0]).toBeGreaterThan(220);
    expect(p.data[1]).toBeLessThan(60);
    expect(p.data[2]).toBeGreaterThan(220);
  });

  it("the preview stage agrees with the full stage", async () => {
    const input = await jpeg(scene);
    const pre = await processBook(input, settings({ rotation: 0, marginPct: 0 }), "preview");
    const full = await processBook(input, settings({ rotation: 0, marginPct: 0 }), "full");
    expect(pre.stage).toBe("preview");
    expect(Math.abs(pre.width / full.width - WORKING_LONG_EDGE / W)).toBeLessThan(0.02);
    expect(pre.bounds && full.bounds && Math.abs(pre.bounds.x - full.bounds.x)).toBeLessThan(0.005);
  });

  it("uncertain detection never crops or removes anything", async () => {
    const grey = markedScene(W, H, book.x, book.y, book.w, book.h, { bg: [30, 0.04, 0.5] });
    const input = await jpeg(grey);
    const r = await processBook(input, settings({ rotation: 0 }), "full");
    expect(r.status).toBe("NEEDS_REVIEW");
    expect(r.applied.cropped).toBe(false);
    expect(r.applied.backgroundRemoved).toBe(false);
    expect([r.width, r.height]).toEqual([W, H]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("a manual confirmation and manual crop override the automatic result", async () => {
    const grey = markedScene(W, H, book.x, book.y, book.w, book.h, { bg: [30, 0.04, 0.5] });
    const input = await jpeg(grey);
    const r = await processBook(input, settings({ rotation: 0 }, { confirmed: true, crop: { x: 0.25, y: 0.1, w: 0.5, h: 0.8 } }), "full");
    expect(r.status).toBe("DONE");
    expect([r.width, r.height]).toEqual([Math.round(0.5 * W), Math.round(0.8 * H)]);
  });

  it("rotation only: no segmentation, whole frame kept", async () => {
    const input = await jpeg(scene);
    const r = await processBook(input, settings({ rotation: 90, removeBackground: false, autoCrop: false }), "full");
    expect(r.status).toBe("DONE");
    expect([r.width, r.height]).toEqual([H, W]);
  });
});

describe("20 shots in a row each keep their own identity", () => {
  it("every processed image carries its own marker", async () => {
    // 5 bit id painted as black/white squares on the cover
    const ids = Array.from({ length: 20 }, (_, i) => i + 1);
    const outputs = await Promise.all(
      ids.map(async (id) => {
        const lf = leatherFill(160, 30);
        const s = renderScene({
          width: 640,
          height: 440,
          outline: roundedRect(160, 30, 320, 380, 12, 4),
          seed: id,
          fill: (x, y) => {
            if (y > 50 && y < 80 && x > 180 && x < 180 + 5 * 40) {
              const bit = Math.floor((x - 180) / 40);
              return (id >> bit) & 1 ? [250, 250, 250] : [10, 10, 10];
            }
            return lf(x, y);
          },
        });
        return { id, out: await processBook(await jpeg(s), settings({ rotation: 0, marginPct: 0 }), "preview") };
      }),
    );
    for (const { id, out } of outputs) {
      const p = await pixels(out.data);
      // marker row sits 20..50 px below the book's top edge (preview is not rescaled at 640 px)
      const y = 50 - 30 + 10;
      let decoded = 0;
      for (let bit = 0; bit < 5; bit++) {
        const x = 20 + bit * 40 + 20;
        const v = p.data[(y * p.w + x) * p.c]!;
        if (v > 128) decoded |= 1 << bit;
      }
      expect(decoded).toBe(id);
    }
  });
});
