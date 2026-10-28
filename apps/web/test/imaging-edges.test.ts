import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { processBook } from "@/server/services/book-image";
import { segmentBook } from "@/lib/imaging/segment";
import { DEFAULT_PROCESSING, photoProcessingSchema, type PhotoProcessing } from "@/lib/imaging/settings";
import { leatherFill, renderScene, roundedRect, type Scene } from "./imaging-fixtures";

const settings = (over: Partial<PhotoProcessing["settings"]> = {}): PhotoProcessing => photoProcessingSchema.parse({ settings: { ...DEFAULT_PROCESSING, ...over } });

async function jpeg(scene: Scene): Promise<Buffer> {
  return sharp(Buffer.from(scene.rgb), { raw: { width: scene.width, height: scene.height, channels: 3 } }).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
}

async function rgba(buf: Buffer) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

/** green excess g − max(r, b) of the pixels that are only partly transparent (the matte's edge) */
function edgeStats(p: { data: Buffer; w: number; h: number }) {
  let partial = 0;
  let excess = 0;
  for (let i = 0; i < p.w * p.h; i++) {
    const a = p.data[i * 4 + 3]!;
    if (a > 8 && a < 247) {
      partial++;
      excess += Math.max(0, p.data[i * 4 + 1]! - Math.max(p.data[i * 4]!, p.data[i * 4 + 2]!));
    }
  }
  return { partial, meanExcess: partial ? excess / partial : 0 };
}

const iou = (a: Uint8Array, b: Uint8Array) => {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) inter++;
    if (a[i] || b[i]) union++;
  }
  return union ? inter / union : 1;
};

function cover(w: number, h: number, bx: number, by: number, bw: number, bh: number, extra: Partial<Parameters<typeof renderScene>[0]> = {}) {
  const lf = leatherFill(bx, by);
  return renderScene({ width: w, height: h, outline: roundedRect(bx, by, bw, bh, 18, 6), fill: lf, ...extra });
}

describe("edge quality of the cut-out", () => {
  const scene = cover(1800, 1300, 450, 200, 900, 880);

  it("the cut has a real soft edge and no green fringe (natural)", async () => {
    const out = await processBook(await jpeg(scene), settings({ rotation: 0, background: "transparent", marginPct: 0 }), "full");
    const e = edgeStats(await rgba(out.data));
    expect(out.hasAlpha).toBe(true);
    expect(e.partial).toBeGreaterThan(1500); // anti-aliased boundary, not a staircase
    expect(e.meanExcess).toBeLessThan(10); // the backdrop's green is taken out of the edge pixels
  });

  it("precise is crisper than natural, soft is wider than natural", async () => {
    const input = await jpeg(scene);
    const partial = async (edgeQuality: "precise" | "natural" | "soft") =>
      edgeStats(await rgba((await processBook(input, settings({ rotation: 0, background: "transparent", marginPct: 0, edgeQuality }), "full")).data)).partial;
    const [precise, natural, soft] = [await partial("precise"), await partial("natural"), await partial("soft")];
    expect(precise).toBeLessThan(natural);
    expect(natural).toBeLessThan(soft);
  });

  it("the preview stage uses the same matte as the final file", async () => {
    const input = await jpeg(scene);
    const prev = await processBook(input, settings({ rotation: 0, background: "transparent", marginPct: 0 }), "preview");
    expect(edgeStats(await rgba(prev.data)).meanExcess).toBeLessThan(12);
  });

  it("a deep shadow in the backdrop (dark green with the backdrop's chroma) is not part of the book", () => {
    const s = cover(1200, 900, 300, 200, 600, 520, { shadow: { dx: 0, dy: -30, blur: 28, strength: 0.88 } });
    const r = segmentBook({ data: s.rgb, width: s.width, height: s.height, channels: 3 }, { sensitivity: 50, bgSample: null });
    expect(iou(r.mask, s.truth)).toBeGreaterThan(0.97);
  });
});

describe("a real photo: open Talmud spread on the green screen, red page edges", () => {
  const file = path.join(__dirname, "fixtures", "spread-on-green.jpg");

  it("no green is left anywhere on the cut-out, the page edges stay intact", async () => {
    const out = await processBook(fs.readFileSync(file), settings({ background: "transparent" }), "full");
    expect(out.status).toBe("DONE");
    const p = await rgba(out.data);
    let opaque = 0;
    let green = 0;
    for (let i = 0; i < p.w * p.h; i++) {
      if (p.data[i * 4 + 3]! < 200) continue;
      opaque++;
      const r = p.data[i * 4]!;
      const g = p.data[i * 4 + 1]!;
      const b = p.data[i * 4 + 2]!;
      if (g - Math.max(r, b) > 25 && g > 35) green++;
    }
    expect(opaque / (p.w * p.h)).toBeGreaterThan(0.7); // the book is kept, not eaten
    expect(green / opaque).toBeLessThan(0.0008); // no band of backdrop under/over the book
    expect(edgeStats(p).meanExcess).toBeLessThan(12);
  }, 120000);
});
