import "server-only";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db, type Tx } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { Principal, UserPrincipal } from "../auth/principal";
import { asJson } from "../json";

/*
 * Customers = the people who BUY. Separate from consignors (who deposit books): the same person may exist in both lists
 * as two records and nothing links them automatically.
 *
 * Identification (never by name alone, never by a bidder number outside its own sale):
 *   1. a permanent external buyer id (system + id)       2. a unique e-mail     3. a unique phone number
 *   4. a bidder number WITHIN the same sale              5. otherwise a person decides (merge screen)
 */

/* ───────────────────────── normalisation ───────────────────────── */

export function normEmail(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/** digits only; 00/+ prefixes dropped; a leading 0 means Israel (972). Too short / long → null. */
export function normPhone(raw: unknown): string | null {
  let d = (typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : "").replace(/[^\d+]/g, "");
  if (!d) return null;
  const plus = d.startsWith("+");
  d = d.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  else if (!plus && d.startsWith("0")) d = `972${d.slice(1)}`;
  return d.length >= 8 && d.length <= 15 ? d : null;
}

export const addressSchema = z.object({
  label: z.string().trim().max(60).optional(),
  name: z.string().trim().max(200).optional(),
  line1: z.string().trim().max(300),
  line2: z.string().trim().max(300).optional(),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(120).optional(),
  zip: z.string().trim().max(30).optional(),
  country: z.string().trim().max(120).optional(),
});
export type Address = z.infer<typeof addressSchema>;

export const customerInputSchema = z.object({
  name: z.string().trim().min(1, "שם הלקוח נדרש").max(200),
  email: z.string().trim().max(200).nullish(),
  phone: z.string().trim().max(60).nullish(),
  addresses: z.array(addressSchema).max(10).optional(),
  notes: z.string().trim().max(5000).nullish(),
});
export const customerPatchSchema = customerInputSchema.partial();

/* ───────────────────────── identity ───────────────────────── */

export type IdentityFields = {
  /** permanent id in an external system */
  buyerId?: string | null;
  system?: string;
  /** the number the buyer had in THIS sale */
  bidderNumber?: string | null;
  catalogId?: string | null;
  email?: string | null;
  phone?: string | null;
};

export type CustomerMatch =
  | { kind: "EXISTING"; customerId: string; by: "buyerId" | "email" | "phone" | "bidder" }
  | { kind: "AMBIGUOUS"; customerIds: string[]; reason: string }
  | { kind: "NONE" };

/** Finds the customer for these identifiers, or says it is unclear. Writes nothing. */
export async function matchCustomer(tx: Tx | typeof db, orgId: string, f: IdentityFields): Promise<CustomerMatch> {
  const system = f.system ?? "bidspirit";
  const found = new Map<string, "buyerId" | "email" | "phone" | "bidder">();
  const live = { organizationId: orgId, status: "ACTIVE" as const };

  if (f.buyerId) {
    const ids = await tx.customerExternalIdentity.findMany({ where: { organizationId: orgId, system, context: "", kind: "BUYER_ID", externalId: f.buyerId }, select: { customerId: true } });
    for (const i of ids) found.set(i.customerId, "buyerId");
    // a permanent id decides on its own
    if (found.size === 1) return { kind: "EXISTING", customerId: [...found.keys()][0]!, by: "buyerId" };
  }
  const email = normEmail(f.email);
  const phone = normPhone(f.phone);
  const byEmail = email ? await tx.customer.findMany({ where: { ...live, emailNorm: email }, select: { id: true } }) : [];
  const byPhone = phone ? await tx.customer.findMany({ where: { ...live, phoneNorm: phone }, select: { id: true } }) : [];
  if (byEmail.length > 1) return { kind: "AMBIGUOUS", customerIds: byEmail.map((c) => c.id), reason: "כמה לקוחות עם אותו אימייל" };
  if (byPhone.length > 1 && !byEmail.length) return { kind: "AMBIGUOUS", customerIds: byPhone.map((c) => c.id), reason: "כמה לקוחות עם אותו טלפון" };
  if (byEmail[0] && byPhone[0] && byEmail[0].id !== byPhone[0].id) {
    return { kind: "AMBIGUOUS", customerIds: [byEmail[0].id, byPhone[0].id], reason: "האימייל והטלפון שייכים ללקוחות שונים" };
  }
  if (byEmail[0]) return { kind: "EXISTING", customerId: byEmail[0].id, by: "email" };
  if (byPhone[0]) return { kind: "EXISTING", customerId: byPhone[0].id, by: "phone" };

  if (f.bidderNumber && f.catalogId) {
    const b = await tx.customerExternalIdentity.findMany({ where: { organizationId: orgId, system, context: f.catalogId, kind: "BIDDER_NUMBER", externalId: f.bidderNumber }, select: { customerId: true } });
    const ids = [...new Set(b.map((x) => x.customerId))];
    if (ids.length === 1) return { kind: "EXISTING", customerId: ids[0]!, by: "bidder" };
  }
  return { kind: "NONE" };
}

/** adds the external identifiers of a customer (idempotent) */
export async function attachIdentities(tx: Tx, orgId: string, customerId: string, f: IdentityFields) {
  const system = f.system ?? "bidspirit";
  const rows: { context: string; kind: string; externalId: string }[] = [];
  if (f.buyerId) rows.push({ context: "", kind: "BUYER_ID", externalId: f.buyerId });
  if (f.bidderNumber && f.catalogId) rows.push({ context: f.catalogId, kind: "BIDDER_NUMBER", externalId: f.bidderNumber });
  for (const r of rows) {
    await tx.customerExternalIdentity.upsert({
      where: { organizationId_system_context_kind_externalId: { organizationId: orgId, system, ...r } },
      create: { organizationId: orgId, customerId, system, ...r },
      update: {},
    });
  }
}

async function nextCustomerNumber(tx: Tx, orgId: string) {
  // one writer at a time per organization
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"customer:" + orgId}))`;
  const agg = await tx.customer.aggregate({ where: { organizationId: orgId }, _max: { number: true } });
  return (agg._max.number ?? 0) + 1;
}

export async function createCustomerTx(
  tx: Tx,
  principal: Principal,
  input: { name: string; email?: string | null; phone?: string | null; addresses?: Address[]; notes?: string | null; needsDetails?: boolean },
  ids: IdentityFields = {},
) {
  const c = await tx.customer.create({
    data: {
      organizationId: principal.organizationId,
      number: await nextCustomerNumber(tx, principal.organizationId),
      name: input.name,
      email: input.email?.trim() || null,
      emailNorm: normEmail(input.email),
      phone: input.phone?.trim() || null,
      phoneNorm: normPhone(input.phone),
      addresses: asJson(input.addresses ?? []),
      notes: input.notes ?? null,
      needsDetails: input.needsDetails ?? false,
      createdById: principal.kind === "user" ? principal.userId : null,
    },
  });
  await attachIdentities(tx, principal.organizationId, c.id, ids);
  return c;
}

export async function createCustomer(user: UserPrincipal, raw: z.input<typeof customerInputSchema>) {
  const input = customerInputSchema.parse(raw);
  if (input.email && !normEmail(input.email)) throw new AppError("VALIDATION", "כתובת האימייל אינה תקינה");
  if (input.phone && !normPhone(input.phone)) throw new AppError("VALIDATION", "מספר הטלפון אינו תקין");
  return db.$transaction(async (tx) => {
    // a manual create that clashes with a person already in the list is refused (merge / open the existing one)
    const m = await matchCustomer(tx, user.organizationId, { email: input.email, phone: input.phone });
    if (m.kind !== "NONE") {
      const ids = m.kind === "EXISTING" ? [m.customerId] : m.customerIds;
      throw new AppError("CONFLICT", "כבר קיים לקוח עם אותו אימייל או טלפון", { code: "DUPLICATE_CUSTOMER", customerIds: ids });
    }
    const c = await createCustomerTx(tx, user, input);
    await tx.saleEvent.create({ data: { organizationId: user.organizationId, customerId: c.id, kind: "CUSTOMER_CREATED", userId: user.userId } });
    await audit(user, { action: "customer.created", entityType: "settings", entityId: c.id, data: { number: c.number } }, tx);
    return c;
  });
}

export async function updateCustomer(user: UserPrincipal, id: string, raw: z.input<typeof customerPatchSchema>) {
  const input = customerPatchSchema.parse(raw);
  const cur = await db.customer.findFirst({ where: { id, organizationId: user.organizationId } });
  if (!cur) throw notFound("הלקוח");
  if (cur.status === "MERGED") throw new AppError("CONFLICT", "הלקוח מוזג ללקוח אחר");
  if (input.email && !normEmail(input.email)) throw new AppError("VALIDATION", "כתובת האימייל אינה תקינה");
  if (input.phone && !normPhone(input.phone)) throw new AppError("VALIDATION", "מספר הטלפון אינו תקין");
  const data: Prisma.CustomerUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.email !== undefined) Object.assign(data, { email: input.email?.trim() || null, emailNorm: normEmail(input.email) });
  if (input.phone !== undefined) Object.assign(data, { phone: input.phone?.trim() || null, phoneNorm: normPhone(input.phone) });
  if (input.addresses !== undefined) data.addresses = asJson(input.addresses);
  if (input.notes !== undefined) data.notes = input.notes;
  const complete = (input.name ?? cur.name) && ((input.email !== undefined ? normEmail(input.email) : cur.emailNorm) || (input.phone !== undefined ? normPhone(input.phone) : cur.phoneNorm));
  if (complete) data.needsDetails = false;
  return db.$transaction(async (tx) => {
    const u = await tx.customer.update({ where: { id }, data });
    await tx.saleEvent.create({ data: { organizationId: user.organizationId, customerId: id, kind: "CUSTOMER_UPDATED", data: asJson({ fields: Object.keys(input) }), userId: user.userId } });
    return u;
  });
}

/* ───────────────────────── merge ───────────────────────── */

/**
 * Merges `fromId` into `intoId` after a person confirmed it. Purchases, orders, payments, shipments and identifiers move
 * to the kept customer; nothing is deleted (the source stays as MERGED history). Where both had an order in the same sale
 * the orders become one.
 */
export async function mergeCustomers(user: UserPrincipal, fromId: string, intoId: string) {
  if (fromId === intoId) throw new AppError("VALIDATION", "לא ניתן למזג לקוח לעצמו");
  return db.$transaction(async (tx) => {
    const [a, b] = await Promise.all([
      tx.customer.findFirst({ where: { id: fromId, organizationId: user.organizationId } }),
      tx.customer.findFirst({ where: { id: intoId, organizationId: user.organizationId } }),
    ]);
    if (!a || !b) throw notFound("הלקוח");
    if (a.status === "MERGED" || b.status === "MERGED") throw new AppError("CONFLICT", "אחד הלקוחות כבר מוזג");
    const orders = await tx.buyerOrder.findMany({ where: { customerId: fromId } });
    for (const o of orders) {
      const keep = await tx.buyerOrder.findUnique({ where: { catalogId_customerId: { catalogId: o.catalogId, customerId: intoId } } });
      if (keep) {
        await tx.purchase.updateMany({ where: { orderId: o.id }, data: { orderId: keep.id, customerId: intoId } });
        await tx.payment.updateMany({ where: { orderId: o.id }, data: { orderId: keep.id } });
        await tx.buyerOrder.delete({ where: { id: o.id } });
      } else {
        await tx.buyerOrder.update({ where: { id: o.id }, data: { customerId: intoId } });
        await tx.purchase.updateMany({ where: { orderId: o.id }, data: { customerId: intoId } });
      }
    }
    await tx.shipment.updateMany({ where: { customerId: fromId }, data: { customerId: intoId } });
    // identifiers: ones the kept customer already has stay, the rest move
    const have = await tx.customerExternalIdentity.findMany({ where: { customerId: intoId } });
    const key = (i: { system: string; context: string; kind: string; externalId: string }) => `${i.system}|${i.context}|${i.kind}|${i.externalId}`;
    const haveKeys = new Set(have.map(key));
    for (const i of await tx.customerExternalIdentity.findMany({ where: { customerId: fromId } })) {
      if (haveKeys.has(key(i))) await tx.customerExternalIdentity.delete({ where: { id: i.id } });
      else await tx.customerExternalIdentity.update({ where: { id: i.id }, data: { customerId: intoId } });
    }
    // fill gaps of the kept customer from the merged one (never overwrite)
    await tx.customer.update({
      where: { id: intoId },
      data: {
        email: b.email ?? a.email,
        emailNorm: b.emailNorm ?? a.emailNorm,
        phone: b.phone ?? a.phone,
        phoneNorm: b.phoneNorm ?? a.phoneNorm,
        addresses: asJson([...(b.addresses as Address[]), ...(a.addresses as Address[])].slice(0, 10)),
        notes: [b.notes, a.notes && `(ממוזג מלקוח ${a.number}) ${a.notes}`].filter(Boolean).join("\n") || null,
        needsDetails: b.needsDetails && a.needsDetails,
      },
    });
    await tx.customer.update({ where: { id: fromId }, data: { status: "MERGED", mergedIntoId: intoId, emailNorm: null, phoneNorm: null } });
    await tx.saleEvent.create({ data: { organizationId: user.organizationId, customerId: intoId, kind: "CUSTOMER_MERGED", data: asJson({ from: fromId, fromNumber: a.number, fromName: a.name, into: intoId }), userId: user.userId } });
    await audit(user, { action: "customer.merged", entityType: "settings", entityId: intoId, data: { from: fromId } }, tx);
    return { intoId, fromId };
  });
}

/** possible duplicates of a customer: same normalised e-mail / phone, or the same name (shown for a person to judge, never merged automatically) */
export async function duplicateCandidates(user: UserPrincipal, customerId: string) {
  const c = await db.customer.findFirst({ where: { id: customerId, organizationId: user.organizationId } });
  if (!c) throw notFound("הלקוח");
  const or: Prisma.CustomerWhereInput[] = [{ name: { equals: c.name, mode: "insensitive" } }];
  if (c.emailNorm) or.push({ emailNorm: c.emailNorm });
  if (c.phoneNorm) or.push({ phoneNorm: c.phoneNorm });
  const rows = await db.customer.findMany({ where: { organizationId: user.organizationId, status: "ACTIVE", id: { not: c.id }, OR: or }, take: 20, orderBy: { number: "asc" } });
  return rows.map((r) => ({ id: r.id, number: r.number, name: r.name, email: r.email, phone: r.phone, sameName: r.name.toLowerCase() === c.name.toLowerCase(), sameEmail: !!c.emailNorm && r.emailNorm === c.emailNorm, samePhone: !!c.phoneNorm && r.phoneNorm === c.phoneNorm }));
}
