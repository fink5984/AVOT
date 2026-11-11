import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { processScan } from "@/server/services/scanning";
import { createWarehouseFromWizard, findLocationByCode, renameShelf, shelfContents, warehouseTree } from "@/server/services/warehouse";
import { locationInclude, locationLabel } from "@/server/services/location-label";
import { getItemDetail } from "@/server/services/inventory";
import { createBook, hasDb, makeOrg } from "./helpers";

const store = (code: string, itemCode: string) => ({ opId: randomUUID(), mode: "STORE" as const, code, clientAt: new Date().toISOString(), itemCode });

describe.skipIf(!hasDb)("renaming a shelf (real database)", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  beforeAll(async () => {
    ctx = await makeOrg("shelfrename");
  });

  async function layout(name: string) {
    const wh = await createWarehouseFromWizard(ctx.admin, { name, columns: 2, shelvesPerColumn: 4 });
    const tree = (await warehouseTree(ctx.org.id)).find((w) => w.id === wh.id)!;
    return { wh, zones: tree.zones };
  }

  it("a rename changes the display name only: same shelf, same location and barcode, same books, same history", async () => {
    const { zones } = await layout("מחסן שמות");
    const shelf = zones[0]!.shelves[1]!;
    const location = shelf.locations[0]!;
    const a = await createBook(ctx.editor, { title: "ספר א" });
    const b = await createBook(ctx.editor, { title: "ספר ב" });
    for (const book of [a, b]) {
      await db.inventoryItem.update({ where: { id: book.item.id }, data: { currentLocationId: location.id, physicalStatus: "IN_STORAGE" } });
      await db.inventoryLocationMovement.create({ data: { organizationId: ctx.org.id, inventoryItemId: book.item.id, fromLocationId: null, toLocationId: location.id, kind: "STORE" } });
    }
    const movementsBefore = await db.inventoryLocationMovement.count({ where: { organizationId: ctx.org.id, toLocationId: location.id } });
    const shelvesBefore = await db.shelf.count({ where: { zoneId: zones[0]!.id } });
    const locationsBefore = await db.storageLocation.count({ where: { organizationId: ctx.org.id } });

    const r = await renameShelf(ctx.admin, shelf.id, { name: "  מדף   עליון - הלכה " });
    expect(r).toMatchObject({ changed: true, shelf: { id: shelf.id, code: shelf.code, name: "מדף עליון - הלכה", displayName: "מדף עליון - הלכה" } });

    // nothing was created, replaced or moved
    expect(await db.shelf.count({ where: { zoneId: zones[0]!.id } })).toBe(shelvesBefore);
    expect(await db.storageLocation.count({ where: { organizationId: ctx.org.id } })).toBe(locationsBefore);
    const after = await db.storageLocation.findUniqueOrThrow({ where: { id: location.id }, include: locationInclude });
    expect(after).toMatchObject({ id: location.id, code: location.code, shelfId: shelf.id, active: true });
    expect(after.shelf.id).toBe(shelf.id);
    expect(after.shelf.code).toBe(shelf.code);
    expect((await findLocationByCode(ctx.org.id, location.code))!.id).toBe(location.id);
    expect(await db.inventoryItem.count({ where: { currentLocationId: location.id } })).toBe(2);
    expect(await db.inventoryLocationMovement.count({ where: { organizationId: ctx.org.id, toLocationId: location.id } })).toBe(movementsBefore);

    // the new name is what is shown wherever the location is shown
    expect(locationLabel(after)).toBe("מחסן שמות · עמודה 1 · מדף עליון - הלכה");
    const detail = await getItemDetail(ctx.editor, a.item.id);
    expect(locationLabel(detail!.item.currentLocation!)).toContain("מדף עליון - הלכה");
    expect((await shelfContents(ctx.org.id, shelf.id)).shelf).toMatchObject({ label: "מחסן שמות · עמודה 1 · מדף עליון - הלכה", displayName: "מדף עליון - הלכה", code: shelf.code });
    const tree = (await warehouseTree(ctx.org.id)).flatMap((w) => w.zones).flatMap((z) => z.shelves).find((s) => s.id === shelf.id)!;
    expect(tree.name).toBe("מדף עליון - הלכה");
    // the handheld / picking path: scanning the printed code still reaches this shelf
    const scan = await processScan(ctx.warehouse, store(location.code, a.item.barcode));
    expect(scan.result).toBe("OK");

    // history: who, when, previous and new name
    const entry = await db.auditLog.findFirstOrThrow({ where: { action: "warehouse.shelf_renamed", entityId: shelf.id } });
    expect(entry.userId).toBe(ctx.admin.userId);
    expect(entry.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(entry.data).toMatchObject({ from: expect.stringMatching(/^מדף \d+$/), to: "מדף עליון - הלכה", previousName: null, newName: "מדף עליון - הלכה", locationCodes: [location.code] });

    // a second rename keeps the first name as the "previous" one; resetting returns to the default
    await renameShelf(ctx.admin, shelf.id, { name: "מדף ספרי קודש" });
    expect((await db.auditLog.findMany({ where: { action: "warehouse.shelf_renamed", entityId: shelf.id }, orderBy: { createdAt: "desc" } }))[0]!.data).toMatchObject({ previousName: "מדף עליון - הלכה", newName: "מדף ספרי קודש" });
    expect((await renameShelf(ctx.admin, shelf.id, { name: "מדף ספרי קודש" })).changed).toBe(false);
    await renameShelf(ctx.admin, shelf.id, { name: null });
    expect(locationLabel(await db.storageLocation.findUniqueOrThrow({ where: { id: location.id }, include: locationInclude }))).toBe("מחסן שמות · עמודה 1 · מדף 2");
  });

  it("a name that another shelf of the same column already has - explicit or the default \"מדף N\" - is refused; another column may reuse it", async () => {
    const { zones } = await layout("מחסן התנגשות");
    const [s1, s2, s3] = zones[0]!.shelves;
    await renameShelf(ctx.admin, s1!.id, { name: "מדף הלכה" });
    // exactly the same, different case / spacing / quote style
    await expect(renameShelf(ctx.admin, s2!.id, { name: "מדף  הלכה" })).rejects.toThrow(/כבר יש מדף בשם/);
    await renameShelf(ctx.admin, s2!.id, { name: 'ספרי "הלכה"' });
    await expect(renameShelf(ctx.admin, s3!.id, { name: "ספרי ״הלכה״" })).rejects.toThrow(/כבר יש מדף בשם/);
    // the default name of a shelf that was not renamed is taken too
    await expect(renameShelf(ctx.admin, s3!.id, { name: "מדף 4" })).rejects.toThrow(/כבר יש מדף בשם/);
    // ... but a shelf may take its own default name back
    await renameShelf(ctx.admin, s1!.id, { name: "מדף 1" });
    // the same name in another column is fine
    await renameShelf(ctx.admin, zones[1]!.shelves[0]!.id, { name: 'ספרי "הלכה"' });
    expect((await db.shelf.findUniqueOrThrow({ where: { id: s3!.id } })).name).toBeNull();
  });

  it("two renames to the same name at the same moment: one wins (database rule), the other is told", async () => {
    const { zones } = await layout("מחסן מרוץ");
    const [x, y] = [zones[0]!.shelves[0]!, zones[0]!.shelves[1]!];
    const results = await Promise.allSettled([renameShelf(ctx.admin, x.id, { name: "מדף מיוחד" }), renameShelf(ctx.admin, y.id, { name: "מדף מיוחד" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason?.message)).toMatch(/כבר יש מדף בשם/);
    expect(await db.shelf.count({ where: { zoneId: zones[0]!.id, name: "מדף מיוחד" } })).toBe(1);
  });

  it("another organization's shelf cannot be renamed; an empty or too long name is refused", async () => {
    const other = await makeOrg("shelfrename-other");
    const wh = await createWarehouseFromWizard(other.admin, { name: "מחסן זר", columns: 1, shelvesPerColumn: 1 });
    const tree = (await warehouseTree(other.org.id)).find((w) => w.id === wh.id)!;
    await expect(renameShelf(ctx.admin, tree.zones[0]!.shelves[0]!.id, { name: "מדף גנוב" })).rejects.toThrow(/לא נמצא/);
    const { zones } = await layout("מחסן אורך");
    await expect(renameShelf(ctx.admin, zones[0]!.shelves[0]!.id, { name: "א".repeat(81) })).rejects.toThrow();
  });
});
