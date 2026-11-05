import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { itemInputSchema } from "@/server/services/inventory";
import { lotInputSchema, lotPatchSchema } from "@/server/services/lots";
import { consignorInputSchema } from "@/server/services/consignors";
import { photographerNotesSchema } from "@/server/services/photographer-notes";
import { finishCaptureSchema } from "@/server/services/capture-finish";

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });

describe("no book can be inserted without going through the consignor check", () => {
  it("InventoryItem rows are created only by createItemTx", () => {
    const offenders = files(path.resolve(__dirname, "../src")).filter((f) => /inventoryItem\.(create|createMany|upsert)\(|\.inventoryItem\.create\b/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(path.resolve(__dirname, ".."), f).replaceAll("\\", "/"))).toEqual(["src/server/services/inventory.ts"]);
  });

  it("createItemTx validates the consignor before it allocates a number", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/server/services/inventory.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function createItemTx"));
    expect(body.indexOf("requireConsignor(")).toBeGreaterThan(-1);
    expect(body.indexOf("requireConsignor(")).toBeLessThan(body.indexOf("allocateSerial("));
  });
});

describe("request schemas", () => {
  it("a catalog lot patch cannot carry a consignor (it belongs to the physical book)", () => {
    expect(Object.keys(lotPatchSchema.shape)).not.toContain("consignorId");
    expect(Object.keys(lotInputSchema.shape)).toContain("consignorId");
    expect(Object.keys(itemInputSchema.shape)).toContain("consignorId");
  });

  it("consignor: name required, e-mail validated only when given, phone accepts international formats", () => {
    expect(consignorInputSchema.safeParse({ name: "" }).success).toBe(false);
    expect(consignorInputSchema.safeParse({ name: "א", email: "x" }).success).toBe(false);
    expect(consignorInputSchema.safeParse({ name: "א", email: "" }).success).toBe(true);
    expect(consignorInputSchema.safeParse({ name: "א", phone: "+972 (50) 123-4567" }).success).toBe(true);
    expect(consignorInputSchema.safeParse({ name: "א", phone: "abc" }).success).toBe(false);
  });

  it("photographer notes: bounded length and a positive edit counter", () => {
    expect(photographerNotesSchema.safeParse({ text: "x".repeat(5001), rev: 1 }).success).toBe(false);
    expect(photographerNotesSchema.safeParse({ text: "ok", rev: 0 }).success).toBe(false);
    expect(photographerNotesSchema.safeParse({ text: "", rev: Date.now() }).success).toBe(true);
  });

  it("finish: needs a retry key and one of the three finishing statuses", () => {
    expect(finishCaptureSchema.safeParse({ status: "COMPLETED" }).success).toBe(false);
    expect(finishCaptureSchema.safeParse({ status: "IN_PROGRESS", opId: "00000000-0000-4000-8000-000000000000" }).success).toBe(false);
    expect(finishCaptureSchema.safeParse({ status: "COMPLETED", opId: "00000000-0000-4000-8000-000000000000" }).success).toBe(true);
  });
});
