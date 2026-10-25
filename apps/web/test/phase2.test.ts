import { describe, expect, it } from "vitest";
import { classifyCode, formatInventoryNumber, formatLocationCode, registerCaptureSchema, scanOpSchema } from "@avot/shared";
import { code128Modules, code128Svg, encodeCode128 } from "@/lib/barcode/code128";
import { can } from "@/server/auth/permissions";
import { canSeeHouse, catalogScope } from "@/server/auth/houses";
import { sizeFromDimensions } from "@/server/services/inventory";
import { toZpl } from "@/server/services/labels";
import { lotIdFromCode } from "@/server/services/search";
import { createDebouncer } from "@/lib/scanner/input";

describe("inventory and location codes", () => {
  it("formats brand-neutral inventory numbers", () => {
    expect(formatInventoryNumber(184)).toBe("ITM-000184");
    expect(formatInventoryNumber(1234567)).toBe("ITM-1234567");
  });
  it("builds location codes from the hierarchy", () => {
    expect(formatLocationCode({ zone: "a", shelf: "03", cell: "02" })).toBe("LOC-A-03-02");
    expect(formatLocationCode({ warehouse: "w2", zone: "B", shelf: "1", cell: "10" })).toBe("LOC-W2-B-1-10");
  });
});

describe("scanned code classification", () => {
  it("normalises keyboard-wedge input (case, whitespace, control characters, short numbers)", () => {
    expect(classifyCode(" itm-000184\r\n")).toEqual({ type: "ITEM", value: "ITM-000184" });
    expect(classifyCode("ITM-184")).toEqual({ type: "ITEM", value: "ITM-000184" });
    expect(classifyCode("\u0002LOC-A-03-02\u0003")).toEqual({ type: "LOCATION", value: "LOC-A-03-02" });
  });
  it("recognises command barcodes and legacy catalog labels", () => {
    expect(classifyCode("cmd-pick")).toEqual({ type: "COMMAND", value: "CMD-PICK", mode: "PICK" });
    const id = "6f1c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
    expect(classifyCode(`AVOT-LOT:${id}`)).toEqual({ type: "LOT", value: id });
    expect(classifyCode(`https://studio.example/l/${id.toUpperCase()}`)).toEqual({ type: "LOT", value: id });
    expect(lotIdFromCode(`AVOT-LOT:${id}`)).toBe(id);
  });
  it("leaves anything else as UNKNOWN (an external barcode registered on a book)", () => {
    expect(classifyCode("9781234567897").type).toBe("UNKNOWN");
    expect(classifyCode("LOC-").type).toBe("UNKNOWN");
  });
});

describe("Code 128", () => {
  it("encodes subset B with the standard checksum", () => {
    // reference computed independently: (104 + Σ value·position) mod 103
    expect(encodeCode128("Wikipedia")).toEqual([104, 55, 73, 75, 73, 80, 69, 68, 73, 65, 88, 106]);
  });
  it("switches to subset C for digit runs (shorter bars for ITM numbers)", () => {
    const v = encodeCode128("ITM-000184");
    expect(v.slice(0, 9)).toEqual([104, 41, 52, 45, 13, 99, 0, 1, 84]);
    const sum = v.slice(0, -2).reduce((a, x, i) => a + (i === 0 ? x : x * i), 0);
    expect(v[v.length - 2]).toBe(sum % 103);
    expect(v[v.length - 1]).toBe(106);
  });
  it("produces 11 modules per symbol and 13 for STOP", () => {
    const text = "LOC-A-03-02";
    const symbols = encodeCode128(text).length;
    expect(code128Modules(text).reduce((a, b) => a + b, 0)).toBe(11 * (symbols - 1) + 13);
    expect(code128Svg(text)).toContain("<svg");
  });
  it("rejects non-ASCII content", () => {
    expect(() => encodeCode128("ספר")).toThrow();
  });
});

describe("ZPL", () => {
  it("prints the code as Code 128 and escapes ZPL control characters in text", () => {
    const zpl = toZpl({ books: [{ id: "1", code: "ITM-000184", title: "ספר ^בדיקה~", subtitle: null }], size: { widthMm: 50, heightMm: 25 } });
    expect(zpl).toContain("^XA");
    expect(zpl).toContain("^BCN");
    expect(zpl).toContain("^FDITM-000184^FS");
    expect(zpl).toContain("^CI28");
    expect(zpl).not.toMatch(/ספר \^/);
    expect(zpl).toContain("\\5e");
    expect(zpl).toContain("\\7e");
  });
});

describe("Phase 2 permissions", () => {
  it("separates warehouse, photography and commercial roles", () => {
    expect(can("WAREHOUSE", "warehouse.operate")).toBe(true);
    expect(can("WAREHOUSE", "photo.capture")).toBe(false);
    expect(can("WAREHOUSE", "catalog.view")).toBe(false);
    expect(can("WAREHOUSE", "warehouse.manage")).toBe(false);
    expect(can("PHOTOGRAPHER", "warehouse.operate")).toBe(false);
    expect(can("PHOTOGRAPHER", "inventory.create")).toBe(true);
    expect(can("VIEWER", "warehouse.operate")).toBe(false);
    expect(can("VIEWER", "warehouse.view")).toBe(true);
    expect(can("EDITOR", "catalog.assign")).toBe(true);
    expect(can("EDITOR", "warehouse.manage")).toBe(false);
    expect(can("ADMIN", "warehouse.manage")).toBe(true);
  });
  it("scopes commercial data by auction house", () => {
    expect(canSeeHouse({ houseIds: null }, "x")).toBe(true);
    expect(canSeeHouse({ houseIds: ["a"] }, "b")).toBe(false);
    expect(catalogScope({ houseIds: ["a"] })).toEqual({ auctionHouseId: { in: ["a"] } });
    expect(catalogScope({ houseIds: null })).toEqual({});
  });
});

describe("inventory helpers", () => {
  it("derives a size class only from known dimensions", () => {
    expect(sizeFromDimensions(null, null)).toBe("UNKNOWN");
    expect(sizeFromDimensions(180, 120)).toBe("SMALL");
    expect(sizeFromDimensions(240, 170)).toBe("MEDIUM");
    expect(sizeFromDimensions(400, 300)).toBe("LARGE");
    expect(sizeFromDimensions(520, 380)).toBe("OVERSIZE");
  });
});

describe("contracts", () => {
  const file = { role: "PRIMARY", originalFilename: "a.jpg", mimeType: "image/jpeg", sizeBytes: 1, sha256: "a".repeat(64) };
  const base = { captureId: "6f1c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f", category: "COVER", source: "WEBCAM", capturedAt: new Date().toISOString(), files: [file] };
  it("accepts a capture for an inventory book or a lot, but needs one of them", () => {
    expect(registerCaptureSchema.safeParse({ ...base, inventoryItemId: base.captureId }).success).toBe(true);
    expect(registerCaptureSchema.safeParse({ ...base, lotId: base.captureId }).success).toBe(true);
    expect(registerCaptureSchema.safeParse(base).success).toBe(false);
  });
  it("validates scan ops (op id is required for idempotency)", () => {
    expect(scanOpSchema.safeParse({ opId: base.captureId, mode: "STORE", code: "ITM-000001", clientAt: base.capturedAt }).success).toBe(true);
    expect(scanOpSchema.safeParse({ mode: "STORE", code: "ITM-000001", clientAt: base.capturedAt }).success).toBe(false);
    expect(scanOpSchema.safeParse({ opId: base.captureId, mode: "DELETE", code: "x", clientAt: base.capturedAt }).success).toBe(false);
  });
});

describe("handheld double-trigger guard", () => {
  it("drops the same code within the window, never a different one", () => {
    const dup = createDebouncer(10_000);
    expect(dup("ITM-000001")).toBe(false);
    expect(dup("ITM-000001")).toBe(true);
    expect(dup("ITM-000002")).toBe(false);
  });
});
