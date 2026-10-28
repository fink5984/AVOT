import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { can } from "@/server/auth/permissions";
import { createItem } from "@/server/services/inventory";
import { bulkCheckout } from "@/server/services/checkout";
import { processScan } from "@/server/services/scanning";
import { startCount } from "@/server/services/counting";
import { bulkManualMove, createWarehouseFromWizard } from "@/server/services/warehouse";
import { hasDb, makeOrg } from "./helpers";

const op = (mode: "STORE" | "COUNT" | "PICK", code: string, extra: Record<string, unknown> = {}) => ({ opId: randomUUID(), mode, code, clientAt: new Date().toISOString(), ...extra });

/** Every warehouse action of the phone has a desktop path that runs the SAME service. */
describe.skipIf(!hasDb)("warehouse actions from the desktop = the phone's actions (real database)", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  let shelfA: { id: string; code: string };
  beforeAll(async () => {
    ctx = await makeOrg("desk");
    const wh = await createWarehouseFromWizard(ctx.admin, { name: "מחסן 1", columns: 2, shelvesPerColumn: 2 });
    shelfA = await db.storageLocation.findFirstOrThrow({ where: { organizationId: ctx.org.id, shelf: { zone: { warehouseId: wh.id, code: "C1" }, code: "01" } } });
  });
  const book = async (title: string) => (await createItem(ctx.editor, { title })).item;

  it("put away / move: bulk relocation from the inventory screen writes the same movement as a phone scan", async () => {
    const a = await book("מהמחשב");
    const b = await book("מהטלפון");
    await bulkManualMove(ctx.warehouse, { itemIds: [a.id], locationId: shelfA.id });
    const s = await processScan(ctx.warehouse, op("STORE", shelfA.code));
    await processScan(ctx.warehouse, op("STORE", b.barcode, { contextLocationId: s.activeLocation!.id }));
    const shape = async (id: string) => {
      const [i, m] = await Promise.all([db.inventoryItem.findUniqueOrThrow({ where: { id } }), db.inventoryLocationMovement.findFirstOrThrow({ where: { inventoryItemId: id } })]);
      return { loc: i.currentLocationId, status: i.physicalStatus, to: m.toLocationId, from: m.fromLocationId, user: m.userId };
    };
    expect(await shape(a.id)).toMatchObject({ loc: shelfA.id, status: "IN_STORAGE", to: shelfA.id, from: null, user: ctx.warehouse.userId });
    expect(await shape(b.id)).toMatchObject({ loc: shelfA.id, status: "IN_STORAGE", to: shelfA.id, from: null, user: ctx.warehouse.userId });
  });

  it("temporary removal: desktop and phone leave the book in the same state; the shelf can take it back", async () => {
    const a = await book("זמני מהמחשב");
    const b = await book("זמני מהטלפון");
    await bulkManualMove(ctx.warehouse, { itemIds: [a.id, b.id], locationId: shelfA.id });
    const r = await bulkCheckout(ctx.warehouse, { itemIds: [a.id], kind: "TEMP" });
    expect(r.done).toEqual([a.id]);
    const phone = await processScan(ctx.warehouse, op("PICK", b.barcode, { intent: "TEMP_OUT" }));
    expect(phone.result).toBe("OK");
    for (const id of [a.id, b.id]) {
      expect(await db.inventoryItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ currentLocationId: null, physicalStatus: "AWAITING_STORAGE" });
      expect(await db.inventoryLocationMovement.findFirstOrThrow({ where: { inventoryItemId: id, toLocationId: null } })).toMatchObject({ fromLocationId: shelfA.id, userId: ctx.warehouse.userId, note: "הוצאה זמנית" });
    }
    // second time: nothing to do, reported, not an error
    expect((await bulkCheckout(ctx.warehouse, { itemIds: [a.id], kind: "TEMP" })).skipped[0]!.message).toMatch(/אינו על מדף/);
    await bulkManualMove(ctx.warehouse, { itemIds: [a.id], locationId: shelfA.id });
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: a.id } })).physicalStatus).toBe("IN_STORAGE");
  });

  it("final removal needs a shipping task, closes it as shipped, and is refused otherwise", async () => {
    const x = await book("סופי");
    await bulkManualMove(ctx.warehouse, { itemIds: [x.id], locationId: shelfA.id });
    expect((await bulkCheckout(ctx.warehouse, { itemIds: [x.id], kind: "FINAL" })).skipped[0]!.message).toMatch(/משלוח/);
    await db.pickTask.create({ data: { organizationId: ctx.org.id, inventoryItemId: x.id, reason: "נמכר", status: "OPEN", sourceLocationId: shelfA.id } });
    expect((await bulkCheckout(ctx.warehouse, { itemIds: [x.id], kind: "FINAL" })).done).toEqual([x.id]);
    expect(await db.inventoryItem.findUniqueOrThrow({ where: { id: x.id } })).toMatchObject({ physicalStatus: "SHIPPED", currentLocationId: null });
    expect((await db.pickTask.findFirstOrThrow({ where: { inventoryItemId: x.id } })).status).toBe("SHIPPED");
  });

  it("stock count entered from the desktop is the phone's count: same session, same discrepancy rules, no auto-move", async () => {
    const counted = await book("נספר");
    const elsewhere = await book("רשום במדף אחר");
    const other = await db.storageLocation.findFirstOrThrow({ where: { organizationId: ctx.org.id, id: { not: shelfA.id } } });
    await bulkManualMove(ctx.warehouse, { itemIds: [counted.id], locationId: shelfA.id });
    await bulkManualMove(ctx.warehouse, { itemIds: [elsewhere.id], locationId: other.id });
    const session = await startCount(ctx.admin, {});
    const shelf = await processScan(ctx.admin, op("COUNT", shelfA.code, { countSessionId: session.id }));
    const ok = await processScan(ctx.admin, op("COUNT", counted.barcode, { contextLocationId: shelf.activeLocation!.id, countSessionId: session.id }));
    const diff = await processScan(ctx.admin, op("COUNT", elsewhere.barcode, { contextLocationId: shelf.activeLocation!.id, countSessionId: session.id }));
    expect(ok.result).toBe("OK");
    expect(diff.warning).toBe(true);
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: elsewhere.id } })).currentLocationId).toBe(other.id);
  });

  it("permissions are the server's: editors move books but cannot ship; photographers and viewers do neither", async () => {
    const y = await book("הרשאות");
    await expect(bulkCheckout(ctx.editor, { itemIds: [y.id], kind: "TEMP" })).resolves.toBeTruthy(); // service itself is role-agnostic…
    // …the API checks the permission before calling it:
    expect(can("EDITOR", "inventory.relocate")).toBe(true);
    expect(can("EDITOR", "pick.fulfil")).toBe(false);
    expect(can("WAREHOUSE", "pick.fulfil")).toBe(true);
    expect(can("PHOTOGRAPHER", "inventory.relocate")).toBe(false);
    expect(can("VIEWER", "inventory.relocate")).toBe(false);
    expect(can("EDITOR", "warehouse.operate")).toBe(false);
  });
});
