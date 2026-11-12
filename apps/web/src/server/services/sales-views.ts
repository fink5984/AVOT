import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "../db";
import { notFound } from "../errors";
import type { UserPrincipal } from "../auth/principal";
import { catalogScope } from "../auth/houses";
import { addMoney } from "@/lib/money";
import { computeLedger, stageOf, type FinancialStatus, type Stage, type OrderLedger } from "./sales";
import { locationInclude, locationLabel } from "./location-label";
import { customerBooks } from "./shipments";
import { listCustomerShipments } from "./shipments";
import type { Address } from "./customers";

/* Read models for the sales screens: "נמכרו", customers, the book / lot pages and the handheld. */

const ledgerKey = (orderId: string) => orderId;

export interface SoldFilters {
  q?: string;
  houseId?: string;
  catalogId?: string;
  customerId?: string;
  financial?: FinancialStatus;
  /** AWAITING_RELEASE | AWAITING_PICK | PICKED | PACKED | SHIPPED | DELIVERED | READY (released, not yet in a shipment) */
  stage?: string;
  take?: number;
}

export interface SoldRow {
  purchaseId: string;
  lotId: string;
  lotNumber: number;
  title: string;
  thumbAssetId: string | null;
  house: string;
  catalogId: string;
  catalogNumber: string;
  saleDate: string | null;
  customerId: string;
  customerName: string;
  customerNumber: number;
  startingPrice: string | null;
  hammerPrice: string;
  afterAuction: boolean;
  financial: FinancialStatus;
  due: string;
  released: boolean;
  releasedUnpaid: boolean;
  stage: Stage;
  /** several physical books in the lot */
  books: { itemId: string; inventoryNumber: string; title: string; location: string | null; stage: Stage }[];
  location: string | null;
  shipmentId: string | null;
  shipmentNumber: number | null;
}

export async function listSold(user: UserPrincipal, f: SoldFilters = {}) {
  const q = f.q?.trim();
  const asNumber = q && /^\d+$/.test(q) ? Number(q) : undefined;
  const purchases = await db.purchase.findMany({
    where: {
      organizationId: user.organizationId,
      status: "ACTIVE",
      catalog: { ...catalogScope(user), ...(f.houseId ? { auctionHouseId: f.houseId } : {}) },
      ...(f.catalogId ? { catalogId: f.catalogId } : {}),
      ...(f.customerId ? { customerId: f.customerId } : {}),
      ...(q
        ? {
            OR: [
              { lot: { title: { contains: q, mode: "insensitive" } } },
              { customer: { name: { contains: q, mode: "insensitive" } } },
              { customer: { email: { contains: q, mode: "insensitive" } } },
              { catalog: { OR: [{ number: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] } },
              { lot: { members: { some: { removedAt: null, item: { OR: [{ inventoryNumber: { contains: q.toUpperCase() } }, { title: { contains: q, mode: "insensitive" } }] } } } } },
              ...(asNumber !== undefined ? [{ lot: { lotNumber: asNumber } }, { customer: { number: asNumber } }] : []),
            ],
          }
        : {}),
    },
    include: {
      lot: { select: { id: true, lotNumber: true, title: true, primaryAssetId: true, startingPrice: true } },
      customer: { select: { id: true, name: true, number: true } },
      catalog: { select: { id: true, number: true, saleDate: true, auctionHouse: { select: { name: true } } } },
    },
    orderBy: [{ createdAt: "desc" }],
    take: 3000,
  });
  const orderIds = [...new Set(purchases.map((p) => p.orderId))];
  const [orderPurchases, payments, members, shipLines] = await Promise.all([
    db.purchase.findMany({ where: { orderId: { in: orderIds } }, select: { id: true, orderId: true, status: true, hammerPrice: true, buyerPremium: true, tax: true, createdAt: true, lot: { select: { lotNumber: true } } } }),
    db.payment.findMany({ where: { orderId: { in: orderIds } }, select: { orderId: true, amount: true, status: true } }),
    db.lotMember.findMany({
      where: { lotId: { in: purchases.map((p) => p.lotId) }, removedAt: null },
      orderBy: { sortOrder: "asc" },
      include: { item: { select: { id: true, inventoryNumber: true, title: true, physicalStatus: true, primaryAssetId: true, currentLocation: { include: locationInclude } } } },
    }),
    db.shipmentItem.findMany({ where: { purchaseId: { in: purchases.map((p) => p.id) }, isActive: true }, include: { shipment: { select: { id: true, number: true, status: true } } } }),
  ]);
  const ledgers = new Map<string, OrderLedger>();
  for (const o of orderIds)
    ledgers.set(ledgerKey(o), computeLedger(o, orderPurchases.filter((x) => x.orderId === o), payments.filter((x) => x.orderId === o)));

  let rows: SoldRow[] = purchases.map((p) => {
    const lg = ledgers.get(ledgerKey(p.orderId))!;
    const mine = lg.purchases.find((x) => x.id === p.id);
    const lines = shipLines.filter((s) => s.purchaseId === p.id);
    const books = members
      .filter((m) => m.lotId === p.lotId)
      .map((m) => {
        const delivered = lines.some((l) => l.inventoryItemId === m.inventoryItemId && l.shipment.status === "DELIVERED");
        return { itemId: m.item.id, inventoryNumber: m.item.inventoryNumber, title: m.item.title, location: m.item.currentLocation ? locationLabel(m.item.currentLocation) : null, stage: stageOf([{ physicalStatus: m.item.physicalStatus, delivered }]), thumb: m.item.primaryAssetId };
      });
    const stage = stageOf(members.filter((m) => m.lotId === p.lotId).map((m) => ({ physicalStatus: m.item.physicalStatus, delivered: lines.some((l) => l.inventoryItemId === m.inventoryItemId && l.shipment.status === "DELIVERED") })));
    const ship = lines[0]?.shipment ?? null;
    return {
      purchaseId: p.id,
      lotId: p.lotId,
      lotNumber: p.lot.lotNumber,
      title: p.lot.title,
      thumbAssetId: p.lot.primaryAssetId ?? books.find((b) => b.thumb)?.thumb ?? null,
      house: p.catalog.auctionHouse.name,
      catalogId: p.catalogId,
      catalogNumber: p.catalog.number,
      saleDate: p.catalog.saleDate?.toISOString() ?? null,
      customerId: p.customerId,
      customerName: p.customer.name,
      customerNumber: p.customer.number,
      startingPrice: (p.startingPriceAtSale ?? p.lot.startingPrice)?.toFixed(2) ?? null,
      hammerPrice: p.hammerPrice.toFixed(2),
      afterAuction: p.afterAuction,
      financial: mine?.status ?? "NONE",
      due: lg.due,
      released: !!p.releasedAt,
      releasedUnpaid: p.releasedUnpaid,
      stage,
      books: books.map(({ thumb: _t, ...b }) => b),
      location: books.length === 1 ? books[0]!.location : null,
      shipmentId: ship?.id ?? null,
      shipmentNumber: ship?.number ?? null,
    };
  });
  if (f.financial) rows = rows.filter((r) => r.financial === f.financial);
  if (f.stage) {
    rows = rows.filter((r) => {
      if (f.stage === "AWAITING_RELEASE") return !r.released && r.stage === "IN_WAREHOUSE";
      if (f.stage === "READY") return r.released && !r.shipmentId && ["AWAITING_PICK", "PICKED", "PACKED", "IN_WAREHOUSE"].includes(r.stage);
      return r.stage === f.stage;
    });
  }
  const take = f.take ?? 1000;
  const summary = {
    soldLots: rows.length,
    soldBooks: rows.reduce((a, r) => a + Math.max(1, r.books.length), 0),
    hammerTotal: addMoney(...rows.map((r) => r.hammerPrice)),
    customers: new Set(rows.map((r) => r.customerId)).size,
    awaitingPayment: rows.filter((r) => r.financial === "UNPAID" || r.financial === "PARTIAL").length,
    awaitingShipment: rows.filter((r) => r.stage !== "SHIPPED" && r.stage !== "DELIVERED").length,
    shipped: rows.filter((r) => r.stage === "SHIPPED" || r.stage === "DELIVERED").length,
  };
  return { summary, rows: rows.slice(0, take), truncated: rows.length > take };
}

/* ───────────────────────── customers ───────────────────────── */

export async function listCustomers(user: UserPrincipal, opts: { q?: string; filter?: "all" | "owing" | "waiting" | "needsDetails"; take?: number } = {}) {
  const q = opts.q?.trim();
  const asNumber = q && /^\d+$/.test(q) ? Number(q) : undefined;
  const customers = await db.customer.findMany({
    where: {
      organizationId: user.organizationId,
      status: "ACTIVE",
      ...(opts.filter === "needsDetails" ? { needsDetails: true } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              { phone: { contains: q } },
              { identities: { some: { externalId: { contains: q } } } },
              ...(asNumber !== undefined ? [{ number: asNumber }] : []),
            ],
          }
        : {}),
    },
    include: { identities: { select: { system: true, kind: true, externalId: true, context: true } } },
    orderBy: { name: "asc" },
    take: opts.take ?? 1000,
  });
  const ids = customers.map((c) => c.id);
  const [purchases, orders, payments] = await Promise.all([
    db.purchase.findMany({ where: { customerId: { in: ids }, status: "ACTIVE" }, select: { id: true, customerId: true, orderId: true, catalogId: true, lotId: true, hammerPrice: true, buyerPremium: true, tax: true, createdAt: true, lot: { select: { lotNumber: true } } } }),
    db.buyerOrder.findMany({ where: { customerId: { in: ids } }, select: { id: true, customerId: true } }),
    db.payment.findMany({ where: { order: { customerId: { in: ids } } }, select: { orderId: true, amount: true, status: true } }),
  ]);
  const members = await db.lotMember.findMany({ where: { lotId: { in: purchases.map((p) => p.lotId) }, removedAt: null }, select: { lotId: true, item: { select: { physicalStatus: true } } } });
  const rows = customers.map((c) => {
    const ps = purchases.filter((p) => p.customerId === c.id);
    let open = "0.00";
    let paid = "0.00";
    let waitingLots = 0;
    for (const o of orders.filter((x) => x.customerId === c.id)) {
      const lg = computeLedger(o.id, ps.filter((p) => p.orderId === o.id).map((p) => ({ ...p, status: "ACTIVE" })), payments.filter((x) => x.orderId === o.id));
      open = addMoney(open, lg.due);
      paid = addMoney(paid, lg.paid);
    }
    for (const p of ps) if (members.filter((m) => m.lotId === p.lotId).some((m) => m.item.physicalStatus !== "SHIPPED")) waitingLots += 1;
    return {
      id: c.id,
      number: c.number,
      name: c.name,
      email: c.email,
      phone: c.phone,
      needsDetails: c.needsDetails,
      external: c.identities.filter((i) => i.kind === "BUYER_ID").map((i) => `${i.system}: ${i.externalId}`),
      sales: new Set(ps.map((p) => p.catalogId)).size,
      lots: ps.length,
      hammerTotal: addMoney(...ps.map((p) => p.hammerPrice.toFixed(2))),
      paid,
      open,
      waitingLots,
    };
  });
  const filtered = rows.filter((r) => (opts.filter === "owing" ? Number(r.open) > 0 : opts.filter === "waiting" ? r.waitingLots > 0 : true));
  return filtered;
}

export async function customerDetail(user: UserPrincipal, id: string) {
  const c = await db.customer.findFirst({ where: { id, organizationId: user.organizationId }, include: { identities: true } });
  if (!c) throw notFound("הלקוח");
  const sold = await listSold(user, { customerId: id, take: 2000 });
  const orders = await db.buyerOrder.findMany({ where: { customerId: id }, include: { catalog: { select: { id: true, number: true, name: true, saleDate: true, auctionHouse: { select: { name: true } } } }, payments: { orderBy: { paidAt: "desc" } } }, orderBy: { createdAt: "desc" } });
  const orderPurchases = await db.purchase.findMany({ where: { orderId: { in: orders.map((o) => o.id) } }, select: { id: true, orderId: true, status: true, hammerPrice: true, buyerPremium: true, tax: true, createdAt: true, lot: { select: { lotNumber: true } } } });
  const orderViews = orders.map((o) => {
    const lg = computeLedger(o.id, orderPurchases.filter((p) => p.orderId === o.id), o.payments);
    return {
      id: o.id,
      catalogId: o.catalog.id,
      catalogNumber: o.catalog.number,
      catalogName: o.catalog.name,
      house: o.catalog.auctionHouse.name,
      saleDate: o.catalog.saleDate?.toISOString() ?? null,
      externalOrderId: o.externalOrderId,
      ledger: lg,
      payments: o.payments.map((p) => ({ id: p.id, amount: p.amount.toFixed(2), paidAt: p.paidAt.toISOString(), method: p.method, reference: p.reference, status: p.status, voidReason: p.voidReason })),
    };
  });
  const totalPaid = addMoney(...orderViews.map((o) => o.ledger.paid));
  const totalOpen = addMoney(...orderViews.map((o) => o.ledger.due));
  const events = await db.saleEvent.findMany({ where: { customerId: id }, orderBy: { createdAt: "desc" }, take: 60 });
  const waiting = await customerBooks(db, user.organizationId, id);
  const shipments = await listCustomerShipments(user, id);
  const first = sold.rows.reduce<string | null>((a, r) => (a === null || (r.saleDate && r.saleDate < a) ? r.saleDate : a), null);
  return {
    customer: {
      id: c.id,
      number: c.number,
      name: c.name,
      email: c.email,
      phone: c.phone,
      addresses: c.addresses as Address[],
      notes: c.notes,
      needsDetails: c.needsDetails,
      status: c.status,
      mergedIntoId: c.mergedIntoId,
      createdAt: c.createdAt.toISOString(),
      identities: c.identities.map((i) => ({ id: i.id, system: i.system, kind: i.kind, context: i.context, externalId: i.externalId })),
    },
    purchases: sold.rows,
    orders: orderViews,
    summary: {
      lots: sold.summary.soldLots,
      books: sold.summary.soldBooks,
      hammerTotal: sold.summary.hammerTotal,
      paid: totalPaid,
      open: totalOpen,
      shippedLots: sold.summary.shipped,
      toShipLots: sold.summary.awaitingShipment,
      firstSale: first,
    },
    waiting,
    shipments,
    events: events.map((e) => ({ id: e.id, kind: e.kind, at: e.createdAt.toISOString(), data: e.data })),
  };
}

/* ───────────────────────── one book / lot / the handheld ───────────────────────── */

/** the sale of a book (when it has an active purchase): buyer, price, states and the customer's other waiting books */
export async function saleOfItem(user: UserPrincipal, itemId: string, opts: { forHandheld?: boolean } = {}) {
  const m = await db.lotMember.findFirst({ where: { organizationId: user.organizationId, inventoryItemId: itemId, removedAt: null, lot: { purchases: { some: { status: "ACTIVE" } } } }, select: { lotId: true } });
  if (!m) return null;
  const p = await db.purchase.findFirst({
    where: { lotId: m.lotId, status: "ACTIVE" },
    include: { customer: { select: { id: true, name: true, number: true } }, lot: { select: { id: true, lotNumber: true } }, catalog: { select: { id: true, number: true, auctionHouse: { select: { name: true } } } } },
  });
  if (!p) return null;
  const books = await customerBooks(db, user.organizationId, p.customerId);
  const others = books.filter((b) => b.purchaseId !== p.id);
  const mine = books.find((b) => b.itemId === itemId);
  const lg = await db.purchase.findMany({ where: { orderId: p.orderId }, select: { id: true, orderId: true, status: true, hammerPrice: true, buyerPremium: true, tax: true, createdAt: true, lot: { select: { lotNumber: true } } } });
  const pay = await db.payment.findMany({ where: { orderId: p.orderId }, select: { amount: true, status: true } });
  const ledger = computeLedger(p.orderId, lg, pay);
  const fin = ledger.purchases.find((x) => x.id === p.id)?.status ?? "NONE";
  const base = {
    purchaseId: p.id,
    customerName: p.customer.name,
    lot: p.lot.lotNumber,
    house: p.catalog.auctionHouse.name,
    catalogNumber: p.catalog.number,
    financial: fin,
    released: !!p.releasedAt,
    stage: mine?.stage ?? "IN_WAREHOUSE",
    shipmentId: mine?.shipmentId ?? null,
    otherWaitingBooks: others.filter((b) => b.stage !== "SHIPPED" && b.stage !== "DELIVERED").length,
    otherPickableBooks: others.filter((b) => b.released && ["AWAITING_PICK"].includes(b.stage)).length,
  };
  // the handheld gets what the task needs - no customer id, no money amounts, no contact details
  if (opts.forHandheld) return base;
  return { ...base, customerId: p.customer.id, customerNumber: p.customer.number, hammerPrice: p.hammerPrice.toFixed(2), catalogId: p.catalogId, lotId: p.lotId, due: ledger.due };
}

/** how many sold lots / books of a catalog are in each state - the numbers on the catalog page */
export async function catalogSalesSummary(catalogId: string) {
  const [sold, hammer] = await Promise.all([db.purchase.count({ where: { catalogId, status: "ACTIVE" } }), db.purchase.aggregate({ where: { catalogId, status: "ACTIVE" }, _sum: { hammerPrice: true } })]);
  return { sold, hammerTotal: (hammer._sum.hammerPrice ?? new Prisma.Decimal(0)).toFixed(2) };
}
