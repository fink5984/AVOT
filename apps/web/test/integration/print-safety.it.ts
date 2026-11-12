import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { createPrintJobs, createPrinter, reprintJob } from "@/server/services/printing";
import { hasDb, makeOrg, createBook } from "./helpers";

/** Print safety: small prints are instant, 6+ labels need a confirmation, 50+ the typed number — enforced on the server. */
describe.skipIf(!hasDb)("print safety (real database)", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  const ids: string[] = [];
  const refs = (n: number) => ids.slice(0, n).map((id) => ({ type: "BOOK" as const, id }));
  const codeOf = async (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code);

  beforeAll(async () => {
    ctx = await makeOrg("psafe");
    await createPrinter(ctx.admin, { name: "Zebra", connection: "NETWORK", host: "10.0.0.8", port: 9100, labelSize: "57x32", dotsPerMm: 8 });
    for (let i = 0; i < 60; i++) ids.push((await createBook(ctx.editor, { title: `ספר ${i}` })).item.id);
  });

  it("a single label and three deliberate clicks in a row print at once, with no confirmation", async () => {
    for (let i = 0; i < 3; i++) {
      const [job] = await createPrintJobs(ctx.editor, { items: refs(1), idemKey: randomUUID() });
      expect(job!.labelCount).toBe(1);
      expect(job!.confirmedCount).toBeNull();
    }
    expect((await db.printJob.count({ where: { organizationId: ctx.org.id } }))).toBe(3);
  });

  it("5 labels are still instant (also 5 books x 1, or 1 book x 5 copies)", async () => {
    expect(await codeOf(createPrintJobs(ctx.editor, { items: refs(5) }))).toBe("OK");
    expect(await codeOf(createPrintJobs(ctx.editor, { items: refs(1), copies: 5 }))).toBe("OK");
  });

  it("6 labels need a confirmation; the error carries what the window shows", async () => {
    const err = await createPrintJobs(ctx.editor, { items: refs(6) }).catch((e) => e);
    expect(err.code).toBe("CONFIRMATION_REQUIRED");
    expect(err.details).toMatchObject({ level: "confirm", labels: 6, items: 6, copies: 1, printerName: "Zebra", kindLabel: "מדבקות ספרים" });
    const before = await db.printJob.count({ where: { organizationId: ctx.org.id } });
    const [job] = await createPrintJobs(ctx.editor, { items: refs(6), confirmed: true });
    expect(job).toMatchObject({ labelCount: 6, batchLabelCount: 6, confirmedCount: 6 });
    expect(await db.printJob.count({ where: { organizationId: ctx.org.id } })).toBe(before + 1);
  });

  it("the count is items × copies, not the number of books: 2 books × 3 copies = 6", async () => {
    const err = await createPrintJobs(ctx.editor, { items: refs(2), copies: 3 }).catch((e) => e);
    expect(err.code).toBe("CONFIRMATION_REQUIRED");
    expect(err.details.labels).toBe(6);
  });

  it("10 labels with a confirmation print; without one nothing is queued", async () => {
    const before = await db.printJob.count({ where: { organizationId: ctx.org.id } });
    expect(await codeOf(createPrintJobs(ctx.editor, { items: refs(10) }))).toBe("CONFIRMATION_REQUIRED");
    expect(await db.printJob.count({ where: { organizationId: ctx.org.id } })).toBe(before);
    expect(await codeOf(createPrintJobs(ctx.editor, { items: refs(10), confirmed: true }))).toBe("OK");
  });

  it("50+ labels need the exact typed number; a tick alone or a wrong number is refused (API bypass attempts)", async () => {
    expect(await codeOf(createPrintJobs(ctx.editor, { items: refs(50) }))).toBe("CONFIRMATION_REQUIRED");
    expect(await codeOf(createPrintJobs(ctx.editor, { items: refs(50), confirmed: true }))).toBe("CONFIRMATION_REQUIRED");
    expect(await codeOf(createPrintJobs(ctx.editor, { items: refs(50), confirmed: true, confirmCount: 49 }))).toBe("CONFIRMATION_REQUIRED");
    // copies make the real count: 30 books × 6 copies = 180
    const err = await createPrintJobs(ctx.editor, { items: refs(30), copies: 6, confirmed: true, confirmCount: 30 }).catch((e) => e);
    expect(err.code).toBe("CONFIRMATION_REQUIRED");
    expect(err.details).toMatchObject({ level: "typed", labels: 180 });
    const jobs = await createPrintJobs(ctx.editor, { items: refs(30), copies: 6, confirmed: true, confirmCount: 180 });
    expect(jobs.reduce((a, j) => a + j.labelCount, 0)).toBe(180);
    expect(jobs.every((j) => j.batchLabelCount === 180 && j.confirmedCount === 180)).toBe(true);
  });

  it("a retry of an accepted request returns the same jobs and prints nothing twice — even without repeating the confirmation", async () => {
    const key = randomUUID();
    const a = await createPrintJobs(ctx.editor, { items: refs(8), idemKey: key, confirmed: true });
    const b = await createPrintJobs(ctx.editor, { items: refs(8), idemKey: key });
    expect(b.map((j) => j.id)).toEqual(a.map((j) => j.id));
    const dup = await db.printJob.count({ where: { organizationId: ctx.org.id, idemKey: { startsWith: key } } });
    expect(dup).toBe(1);
  });

  it("two different requests in a row are two jobs", async () => {
    const [a] = await createPrintJobs(ctx.editor, { items: refs(1), idemKey: randomUUID() });
    const [b] = await createPrintJobs(ctx.editor, { items: refs(1), idemKey: randomUUID() });
    expect(a!.id).not.toBe(b!.id);
  });

  it("a reprint of a big job needs the confirmation as well", async () => {
    const [big] = await createPrintJobs(ctx.editor, { items: refs(12), confirmed: true });
    expect(await codeOf(reprintJob(ctx.editor, big!.id))).toBe("CONFIRMATION_REQUIRED");
    expect(await codeOf(reprintJob(ctx.editor, big!.id, { confirmed: true }))).toBe("OK");
  });

  it("history: who, when, how many, which printer, status", async () => {
    const [job] = await createPrintJobs(ctx.editor, { items: refs(7), confirmed: true });
    const row = await db.printJob.findUniqueOrThrow({ where: { id: job!.id }, include: { printer: true } });
    expect(row).toMatchObject({ createdById: ctx.editor.userId, labelCount: 7, status: "PENDING" });
    expect(row.printer?.name).toBe("Zebra");
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});
