import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { createItem } from "@/server/services/inventory";
import {
  agentTestPrint,
  claimNextPrintJob,
  createPrintJobs,
  listPrinters,
  printAgentHeartbeat,
  reportPrintJob,
  upsertAgentPrinter,
} from "@/server/services/printing";
import { hasDb, makeOrg, pairAgent } from "./helpers";

/** The label printer is plugged into the capture computer: AVOT Capture Desktop (a CAPTURE device) serves the print queue. */
describe.skipIf(!hasDb)("central printing through the capture station (real database)", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  let station: Awaited<ReturnType<typeof pairAgent>>;
  beforeAll(async () => {
    ctx = await makeOrg("station");
    station = await pairAgent(ctx.admin, "CAPTURE", "מחשב הצילום");
  });
  const book = async (title: string) => (await createItem(ctx.editor, { title })).item;
  const drain = async (d = station) => {
    for (let i = 0; i < 30; i++) {
      const c = await claimNextPrintJob(d);
      if (!c) return;
      await reportPrintJob(d, c.jobId, { status: "SENT" });
    }
  };

  it("the station picks its printer from the Windows list; it becomes the system's primary printer", async () => {
    const p = await upsertAgentPrinter(station, { windowsName: "Zebra ZD421 (USB)", labelSize: "57x32", language: "GDI", primary: true, dotsPerMm: 8 });
    expect(p).toMatchObject({ language: "GDI", isPrimary: true, labelSize: "57x32" });
    // choosing it again updates the same printer, it never multiplies
    await upsertAgentPrinter(station, { windowsName: "Zebra ZD421 (USB)", labelSize: "70x40", language: "GDI", primary: true, dotsPerMm: 8 });
    const row = await db.printer.findMany({ where: { organizationId: ctx.org.id } });
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ connection: "WINDOWS", windowsName: "Zebra ZD421 (USB)", labelSize: "70x40", agentId: station.deviceId, isPrimary: true });
  });

  it("a click from any user → the station claims it: a Windows-driver printer gets structured labels (Hebrew title, numeric barcode), no ZPL assumed", async () => {
    const b = await book("מגילת אסתר — מהדורת וילנא");
    const [job] = await createPrintJobs(ctx.warehouse, { items: [{ type: "BOOK", id: b.id }], idemKey: randomUUID() });
    const c = await claimNextPrintJob(station);
    expect(c).not.toBeNull();
    expect(c!.jobId).toBe(job!.id);
    expect(c!.format).toBe("GDI");
    expect(c!.zpl).toBeNull();
    expect(c!.stock).toEqual({ widthMm: 70, heightMm: 40 });
    expect(c!.labels).toEqual([{ type: "BOOK", code: b.barcode, inventoryNumber: b.inventoryNumber, title: "מגילת אסתר — מהדורת וילנא" }]);
    expect(c!.labels![0]).toMatchObject({ code: expect.stringMatching(/^\d{8,}$/) });
    expect(c!.printer).toMatchObject({ connection: "WINDOWS", windowsName: "Zebra ZD421 (USB)" });
    // received in the station, handed to the spooler: SENT — the system does not call it printed
    await reportPrintJob(station, c!.jobId, { status: "SENT" });
    const row = await db.printJob.findUniqueOrThrow({ where: { id: job!.id } });
    expect(row.status).toBe("SENT");
    expect(row.doneAt).toBeNull();
  });

  it("a raw-ZPL printer on the same station still receives ZPL", async () => {
    await upsertAgentPrinter(station, { windowsName: "Zebra ZD421 (USB)", labelSize: "57x32", language: "ZPL", primary: true, dotsPerMm: 8 });
    const b = await book("ZPL");
    await createPrintJobs(ctx.editor, { items: [{ type: "BOOK", id: b.id }] });
    const c = await claimNextPrintJob(station);
    expect(c!.format).toBe("ZPL");
    expect(c!.zpl).toContain(`^FD${b.barcode}^FS`);
    expect(c!.labels).toBeNull();
    await reportPrintJob(station, c!.jobId, { status: "SENT" });
  });

  it("station off: jobs wait in the server queue and admins see it; when the station returns it collects them, in order", async () => {
    await drain();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const b = await book(`בתור ${i}`);
      ids.push((await createPrintJobs(ctx.warehouse, { items: [{ type: "BOOK", id: b.id }] }))[0]!.id);
    }
    const before = await listPrinters(ctx.org.id);
    expect(before.queue.pending).toBe(3);
    const hb = await printAgentHeartbeat(station, { agentVersion: "0.3.0", printers: [{ printerId: before.printers[0]!.id, state: "OFFLINE", detail: "כבויה" }] });
    expect(hb.queue.pending).toBe(3);
    expect((await listPrinters(ctx.org.id)).agents.map((a) => a.id)).toContain(station.deviceId); // a capture station that runs the print service
    const order: string[] = [];
    for (;;) {
      const c = await claimNextPrintJob(station);
      if (!c) break;
      order.push(c.jobId);
      await reportPrintJob(station, c.jobId, { status: "SENT" });
    }
    expect(order).toEqual(ids);
    expect((await listPrinters(ctx.org.id)).queue.pending).toBe(0);
  });

  it("test print from the station's own window uses the same queue; a printer that is off marks the job failed without touching anything else", async () => {
    const printer = await db.printer.findFirstOrThrow({ where: { organizationId: ctx.org.id } });
    const t = await agentTestPrint(station, printer.id);
    const c = await claimNextPrintJob(station);
    expect(c!.jobId).toBe(t.id);
    await reportPrintJob(station, c!.jobId, { status: "FAILED", error: "המדפסת כבויה" });
    const failed = await db.printJob.findUniqueOrThrow({ where: { id: t.id } });
    expect(failed).toMatchObject({ status: "FAILED", error: "המדפסת כבויה" });
    expect((await listPrinters(ctx.org.id)).queue.failedToday).toBeGreaterThanOrEqual(1);
    expect((await db.printer.findUniqueOrThrow({ where: { id: printer.id } })).lastStatus).toBe("ERROR");
  });

  it("organizations are isolated: another organization's station cannot claim, report or test-print on this one's printer", async () => {
    const other = await makeOrg("station-other");
    const theirs = await pairAgent(other.admin, "CAPTURE", "אחר");
    const b = await book("סודי");
    const [job] = await createPrintJobs(ctx.editor, { items: [{ type: "BOOK", id: b.id }] });
    expect(await claimNextPrintJob(theirs)).toBeNull();
    await expect(reportPrintJob(theirs, job!.id, { status: "DONE" })).rejects.toThrow();
    const printer = await db.printer.findFirstOrThrow({ where: { organizationId: ctx.org.id } });
    await expect(agentTestPrint(theirs, printer.id)).rejects.toThrow();
    // …and this organization's station still gets its own job
    expect((await claimNextPrintJob(station))!.jobId).toBe(job!.id);
    await reportPrintJob(station, job!.id, { status: "SENT" });
  });

  it("a revoked station can no longer print", async () => {
    const gone = await pairAgent(ctx.admin, "CAPTURE", "בוטלה");
    await db.device.update({ where: { id: gone.deviceId }, data: { revokedAt: new Date() } });
    await expect(claimNextPrintJob(gone)).rejects.toThrow();
  });
});
