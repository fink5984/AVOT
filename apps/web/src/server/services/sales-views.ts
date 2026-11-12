import "server-only";
import { searchTokens } from "@/lib/search-text";
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
  /** the filter window: several values = any of them */
  houseIds?: string[];
  catalogIds?: string[];
  financials?: string[];
  stages?: string[];
  customerId?: string;
  financial?: FinancialStatus;
  /** AWAITING_RELEASE | AWAITING_PICK | PICKED | PACKED | SHIPPED | DELIVERED | READY (released, not yet in a shipment) | OPEN (still being handled) | DONE (left the warehouse) */
  stage?: string;
  take?: number;
}

export interface SoldRow {
  purchaseId: string;
  /** a sale from the old system (before AVOT): no lot, no catalog, no price and maybe no buyer */
  legacy: boolean;
  lotId: string | null;
  lotNumber: number | null;
  title: string;
  /** the (first) book */
  itemId: string | null;
  inventoryNumber: string | null;
  thumbAssetId: string | null;
  house: string | null;
  catalogId: string | null;
  catalogNumber: string | null;
  saleDate: string | null;
  customerId: string | null;
  customerName: string | null;
  customerNumber: number | null;
  startingPrice: string | null;
  /** null = unknown (a legacy sale), never 0 */
  hammerPrice: string | null;
  afterAuction: boolean;
  financial: FinancialStatus | "UNKNOWN";
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

const bookSelect = { id: true, inventoryNumber: true, title: true, physicalStatus: true, primaryAssetId: true, currentLocation: { include: locationInclude } } as const;

export async function listSold(user: UserPrincipal, f: SoldFilters = {}) {
  const words = searchTokens(f.q);
  const houseIds = [...(f.houseIds ?? []), ...(f.houseId ? [f.houseId] : [])];
  const catalogIds = [...(f.catalogIds ?? []), ...(f.catalogId ? [f.catalogId] : [])];
  const financials = [...(f.financials ?? []), ...(f.financial ? [f.financial] : [])];
  const stages = [...(f.stages ?? []), ...(f.stage ? [f.stage] : [])];
  const catalogOnly = houseIds.length > 0 || catalogIds.length > 0;
  // one search word against everything a sale is looked up by; every word has to match something (any order)
  const wordMatch = (w: string): Prisma.PurchaseWhereInput => {
    const asNumber = /^\d{1,9}$/.test(w) ? Number(w) : undefined;
    const bookMatch: Prisma.InventoryItemWhereInput = { OR: [{ inventoryNumber: { contains: w.toUpperCase() } }, { title: { contains: w, mode: "insensitive" } }, { author: { contains: w, mode: "insensitive" } }] };
    return {
      OR: [
        { lot: { title: { contains: w, mode: "insensitive" } } },
        { customer: { name: { contains: w, mode: "insensitive" } } },
        { customer: { email: { contains: w, mode: "insensitive" } } },
        { catalog: { OR: [{ number: { contains: w, mode: "insensitive" } }, { name: { contains: w, mode: "insensitive" } }] } },
        { lot: { members: { some: { removedAt: null, item: bookMatch } } } },
        { item: bookMatch },
        ...(asNumber !== undefined ? [{ lot: { lotNumber: asNumber } }, { customer: { number: asNumber } }] : []),
      ],
    };
  };
  const purchases = await db.purchase.findMany({
    where: {
      organizationId: user.organizationId,
      status: "ACTIVE",
      // a legacy sale has no catalog, so no auction house: it is visible to everyone who may see sales
      ...(catalogOnly ? { catalog: { ...catalogScope(user), ...(houseIds.length ? { auctionHouseId: { in: houseIds } } : {}) } } : user.houseIds === null ? {} : { OR: [{ catalogId: null }, { catalog: catalogScope(user) }] }),
      ...(catalogIds.length ? { catalogId: { in: catalogIds } } : {}),
      ...(f.customerId ? { customerId: f.customerId } : {}),
      ...(words.length ? { AND: words.map(wordMatch) } : {}),
    },
    include: {
      lot: { select: { id: true, lotNumber: true, title: true, primaryAssetId: true, startingPrice: true } },
      customer: { select: { id: true, name: true, number: true } },
      catalog: { select: { id: true, number: true, saleDate: true, auctionHouse: { select: { name: true } } } },
      item: { select: bookSelect },
    },
    orderBy: [{ createdAt: "desc" }],
    take: 3000,
  });
  const orderIds = [...new Set(purchases.map((p) => p.orderId).filter((x): x is string => !!x))];
  const lotIds = purchases.map((p) => p.lotId).filter((x): x is string => !!x);
  const [orderPurchases, payments, members, shipLines] = await Promise.all([
    db.purchase.findMany({ where: { orderId: { in: orderIds } }, select: { id: true, orderId: true, status: true, hammerPrice: true, buyerPremium: true, tax: true, createdAt: true, lot: { select: { lotNumber: true } } } }),
    db.payment.findMany({ where: { orderId: { in: orderIds } }, select: { orderId: true, amount: true, status: true } }),
    db.lotMember.findMany({ where: { lotId: { in: lotIds }, removedAt: null }, orderBy: { sortOrder: "asc" }, include: { item: { select: bookSelect } } }),
    db.shipmentItem.findMany({ where: { purchaseId: { in: purchases.map((p) => p.id) }, isActive: true }, include: { shipment: { select: { id: true, number: true, status: true } } } }),
  ]);
  const ledgers = new Map<string, OrderLedger>();
  for (const o of orderIds) ledgers.set(ledgerKey(o), computeLedger(o, orderPurchases.filter((x) => x.orderId === o), payments.filter((x) => x.orderId === o)));

  let rows: SoldRow[] = purchases.map((p) => {
    const lg = p.orderId ? ledgers.get(ledgerKey(p.orderId)) : undefined;
    const mine = lg?.purchases.find((x) => x.id === p.id);
    const lines = shipLines.filter((s) => s.purchaseId === p.id);
    // the physical books of the sale: the members of the lot, or the one book a legacy sale hangs on
    const bookRows = p.lotId ? members.filter((m) => m.lotId === p.lotId).map((m) => m.item) : p.item ? [p.item] : [];
    const books = bookRows.map((it) => {
      const delivered = lines.some((l) => l.inventoryItemId === it.id && l.shipment.status === "DELIVERED");
      return { itemId: it.id, inventoryNumber: it.inventoryNumber, title: it.title, location: it.currentLocation ? locationLabel(it.currentLocation) : null, stage: stageOf([{ physicalStatus: it.physicalStatus, delivered }]), thumb: it.primaryAssetId };
    });
    const stage = stageOf(bookRows.map((it) => ({ physicalStatus: it.physicalStatus, delivered: lines.some((l) => l.inventoryItemId === it.id && l.shipment.status === "DELIVERED") })));
    const ship = lines[0]?.shipment ?? null;
    const legacy = !p.lotId;
    return {
      purchaseId: p.id,
      legacy,
      lotId: p.lotId,
      lotNumber: p.lot?.lotNumber ?? null,
      title: p.lot?.title ?? p.item?.title ?? "",
      itemId: books[0]?.itemId ?? null,
      inventoryNumber: books[0]?.inventoryNumber ?? null,
      thumbAssetId: p.lot?.primaryAssetId ?? books.find((b) => b.thumb)?.thumb ?? null,
      house: p.catalog?.auctionHouse.name ?? null,
      catalogId: p.catalogId,
      catalogNumber: p.catalog?.number ?? null,
      saleDate: p.catalog?.saleDate?.toISOString() ?? null,
      customerId: p.customerId,
      customerName: p.customer?.name ?? null,
      customerNumber: p.customer?.number ?? null,
      startingPrice: (p.startingPriceAtSale ?? p.lot?.startingPrice)?.toFixed(2) ?? null,
      hammerPrice: p.hammerPrice?.toFixed(2) ?? null,
      afterAuction: p.afterAuction,
      financial: legacy ? "UNKNOWN" : (mine?.status ?? "NONE"),
      due: lg?.due ?? "0.00",
      released: !!p.releasedAt,
      releasedUnpaid: p.releasedUnpaid,
      stage,
      books: books.map(({ thumb: _t, ...b }) => b),
      location: books.length === 1 ? books[0]!.location : null,
      shipmentId: ship?.id ?? null,
      shipmentNumber: ship?.number ?? null,
    };
  });
  if (financials.length) rows = rows.filter((r) => financials.includes(r.financial));
  if (stages.length) {
    const inStage = (r: SoldRow, st: string) => {
      if (st === "AWAITING_RELEASE") return !r.released && r.stage === "IN_WAREHOUSE";
      if (st === "READY") return r.released && !r.shipmentId && ["AWAITING_PICK", "PICKED", "PACKED", "IN_WAREHOUSE"].includes(r.stage);
      // still being handled = not shipped / delivered yet; done = left the warehouse
      if (st === "OPEN") return r.stage !== "SHIPPED" && r.stage !== "DELIVERED";
      if (st === "DONE") return r.stage === "SHIPPED" || r.stage === "DELIVERED";
      return r.stage === st;
    };
    rows = rows.filter((r) => stages.some((st) => inStage(r, st)));
  }
  const take = f.take ?? 1000;
  const priced = rows.filter((r) => r.hammerPrice !== null);
  const summary = {
    soldLots: rows.length,
    soldBooks: rows.reduce((a, r) => a + Math.max(1, r.books.length), 0),
    /** only sales with a known price; a legacy sale adds nothing here (it is not 0) */
    hammerTotal: addMoney(...priced.map((r) => r.hammerPrice!)),
    unknownPrice: rows.length - priced.length,
    legacy: rows.filter((r) => r.legacy).length,
    customers: new Set(rows.map((r) => r.customerId).filter(Boolean)).size,
    awaitingPayment: rows.filter((r) => r.financial === "UNPAID" || r.financial === "PARTIAL").length,
    awaitingShipment: rows.filter((r) => r.stage !== "SHIPPED" && r.stage !== "DELIVERED").length,
    shipped: rows.filter((r) => r.stage === "SHIPPED" || r.stage === "DELIVERED").length,
  };
  return { summary, rows: rows.slice(0, take), truncated: rows.length > take };
}

/* ───────────────────────── customers ───────────────────────── */

export async function listCustomers(user: UserPrincipal, opts: { q?: string; filter?: "all" | "owing" | "waiting" | "needsDetails"; /** several states: any of them */ filters?: ("owing" | "waiting" | "needsDetails")[]; take?: number } = {}) {
  const states = new Set([...(opts.filters ?? []), ...(opts.filter && opts.filter !== "all" ? [opts.filter] : [])]);
  const words = searchTokens(opts.q);
  const wordMatch = (w: string): Prisma.CustomerWhereInput => {
    const asNumber = /^\d{1,9}$/.test(w) ? Number(w) : undefined;
    return {
      OR: [
        { name: { contains: w, mode: "insensitive" } },
        { email: { contains: w, mode: "insensitive" } },
        { phone: { contains: w } },
        { identities: { some: { externalId: { contains: w } } } },
        ...(asNumber !== undefined ? [{ number: asNumber }] : []),
      ],
    };
  };
  const customers = await db.customer.findMany({
    where: {
      organizationId: user.organizationId,
      status: "ACTIVE",
      // "needs details" is a stored flag, the other two are computed below: with several states chosen a customer may match any of them
      ...(states.has("needsDetails") && states.size === 1 ? { needsDetails: true } : {}),
      ...(words.length ? { AND: words.map(wordMatch) } : {}),
    },
    include: { identities: { select: { system: true, kind: true, externalId: true, context: true } } },
    orderBy: { name: "asc" },
    take: opts.take ?? 1000,
  });
  const ids = customers.map((c) => c.id);
  const [purchases, orders, payments] = await Promise.all([
    db.purchase.findMany({ where: { customerId: { in: ids }, status: "ACTIVE" }, select: { id: true, customerId: true, orderId: true, catalogId: true, lotId: true, inventoryItemId: true, hammerPrice: true, buyerPremium: true, tax: true, createdAt: true, lot: { select: { lotNumber: true } } } }),
    db.buyerOrder.findMany({ where: { customerId: { in: ids } }, select: { id: true, customerId: true } }),
    db.payment.findMany({ where: { order: { customerId: { in: ids } } }, select: { orderId: true, amount: true, status: true } }),
  ]);
  const members = await db.lotMember.findMany({ where: { lotId: { in: purchases.map((p) => p.lotId).filter((x): x is string => !!x) }, removedAt: null }, select: { lotId: true, item: { select: { physicalStatus: true } } } });
  const legacyItems = await db.inventoryItem.findMany({ where: { id: { in: purchases.map((p) => p.inventoryItemId).filter((x): x is string => !!x) } }, select: { id: true, physicalStatus: true } });
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
    for (const p of ps) if (p.lotId ? members.filter((m) => m.lotId === p.lotId).some((m) => m.item.physicalStatus !== "SHIPPED") : legacyItems.some((i) => i.id === p.inventoryItemId && i.physicalStatus !== "SHIPPED")) waitingLots += 1;
    return {
      id: c.id,
      number: c.number,
      name: c.name,
      email: c.email,
      phone: c.phone,
      needsDetails: c.needsDetails,
      external: c.identities.filter((i) => i.kind === "BUYER_ID").map((i) => `${i.system}: ${i.externalId}`),
      sales: new Set(ps.map((p) => p.catalogId).filter(Boolean)).size,
      lots: ps.length,
      hammerTotal: addMoney(...ps.map((p) => p.hammerPrice?.toFixed(2))),
      paid,
      open,
      waitingLots,
    };
  });
  const filtered = rows.filter((r) => states.size === 0 || (states.has("owing") && Number(r.open) > 0) || (states.has("waiting") && r.waitingLots > 0) || (states.has("needsDetails") && r.needsDetails));
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

/**
 * the sale of a book (when it has an active purchase): buyer, price, states and the customer's other waiting books.
 * A sale from the old system hangs on the book itself (no lot, no catalog, price and buyer may be unknown).
 */
export async function saleOfItem(user: UserPrincipal, itemId: string, opts: { forHandheld?: boolean } = {}) {
  const m = await db.lotMember.findFirst({ where: { organizationId: user.organizationId, inventoryItemId: itemId, removedAt: null, lot: { purchases: { some: { status: "ACTIVE" } } } }, select: { lotId: true } });
  const p = await db.purchase.findFirst({
    where: m ? { lotId: m.lotId, status: "ACTIVE" } : { inventoryItemId: itemId, lotId: null, status: "ACTIVE" },
    include: { customer: { select: { id: true, name: true, number: true } }, lot: { select: { id: true, lotNumber: true } }, catalog: { select: { id: true, number: true, auctionHouse: { select: { name: true } } } } },
  });
  if (!p) return null;
  const books = p.customerId ? await customerBooks(db, user.organizationId, p.customerId) : [];
  const others = books.filter((b) => b.purchaseId !== p.id);
  const mine = books.find((b) => b.itemId === itemId);
  let fin: FinancialStatus | "UNKNOWN" = "UNKNOWN";
  let due = "0.00";
  if (p.orderId) {
    const lg = await db.purchase.findMany({ where: { orderId: p.orderId }, select: { id: true, orderId: true, status: true, hammerPrice: true, buyerPremium: true, tax: true, createdAt: true, lot: { select: { lotNumber: true } } } });
    const pay = await db.payment.findMany({ where: { orderId: p.orderId }, select: { amount: true, status: true } });
    const ledger = computeLedger(p.orderId, lg, pay);
    fin = ledger.purchases.find((x) => x.id === p.id)?.status ?? "NONE";
    due = ledger.due;
  }
  let stage = mine?.stage;
  if (!stage) {
    const it = await db.inventoryItem.findUnique({ where: { id: itemId }, select: { physicalStatus: true } });
    stage = stageOf([{ physicalStatus: it?.physicalStatus ?? "IN_STORAGE" }]);
  }
  const base = {
    purchaseId: p.id,
    legacy: !p.lotId,
    customerName: p.customer?.name ?? null,
    lot: p.lot?.lotNumber ?? null,
    house: p.catalog?.auctionHouse.name ?? null,
    catalogNumber: p.catalog?.number ?? null,
    financial: fin,
    released: !!p.releasedAt,
    stage,
    shipmentId: mine?.shipmentId ?? null,
    otherWaitingBooks: others.filter((b) => b.stage !== "SHIPPED" && b.stage !== "DELIVERED").length,
    otherPickableBooks: others.filter((b) => b.released && ["AWAITING_PICK"].includes(b.stage)).length,
  };
  // the handheld gets what the task needs - no customer id, no money amounts, no contact details
  if (opts.forHandheld) return base;
  return { ...base, customerId: p.customer?.id ?? null, customerNumber: p.customer?.number ?? null, hammerPrice: p.hammerPrice?.toFixed(2) ?? null, catalogId: p.catalogId, lotId: p.lotId, due };
}

/** how many sold lots / books of a catalog are in each state - the numbers on the catalog page */
export async function catalogSalesSummary(catalogId: string) {
  const [sold, hammer] = await Promise.all([db.purchase.count({ where: { catalogId, status: "ACTIVE" } }), db.purchase.aggregate({ where: { catalogId, status: "ACTIVE" }, _sum: { hammerPrice: true } })]);
  return { sold, hammerTotal: (hammer._sum.hammerPrice ?? new Prisma.Decimal(0)).toFixed(2) };
}
