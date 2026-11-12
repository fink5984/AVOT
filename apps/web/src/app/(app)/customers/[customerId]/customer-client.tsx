"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ban, CreditCard, GitMerge, PackageCheck, Pencil, Send } from "lucide-react";
import type { customerDetail } from "@/server/services/sales-views";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Panel, Stat } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { FinancialBadge, ShipmentBadge, StageBadge } from "@/components/sales/status";
import { PrepareShipmentDialog } from "@/components/sales/prepare-shipment-dialog";
import { api, errorMessage } from "@/lib/api";
import { formatUsd, parseUsd } from "@/lib/money";
import { fmt } from "@/i18n";

type Data = Awaited<ReturnType<typeof customerDetail>>;
type Perms = { edit: boolean; payment: boolean; release: boolean; releaseUnpaid: boolean; ship: boolean; correct: boolean; cancel: boolean };

const EVENT: Record<string, string> = {
  CUSTOMER_CREATED: "הלקוח נוצר",
  CUSTOMER_UPDATED: "פרטי הלקוח עודכנו",
  CUSTOMER_MERGED: "לקוח אחר מוזג לכאן",
  SOLD: "נרשמה רכישה",
  SOLD_AFTER_AUCTION: "נרשמה רכישה לאחר המכרז",
  CORRECTED: "רכישה תוקנה ידנית",
  CANCELLED: "עסקה בוטלה",
  PAYMENT: "נרשם תשלום",
  PAYMENT_VOIDED: "תשלום בוטל",
  RELEASED: "שוחרר לליקוט",
  RELEASED_UNPAID: "שוחרר לליקוט לפני תשלום",
  IMPORT_CHANGED: "עודכן מקובץ מתוקן",
  SHIPMENT_CREATED: "נוצר משלוח",
  SHIPMENT_SHIPPED: "משלוח נשלח",
  SHIPMENT_HANDED_OVER: "נמסר ללקוח",
  SHIPMENT_DELIVERED: "משלוח נמסר",
  SHIPMENT_CANCELLED: "משלוח בוטל",
  BOOK_RETURNED: "ספר הוחזר",
};

export function CustomerClient({ data, perms }: { data: Data; perms: Perms }) {
  const router = useRouter();
  const toast = useToast();
  const c = data.customer;
  const [catalog, setCatalog] = useState("");
  const [fin, setFin] = useState("");
  const [stage, setStage] = useState("");
  const [prep, setPrep] = useState<string | null | "all">(null);
  const [edit, setEdit] = useState(false);
  const [payFor, setPayFor] = useState<string | null>(null);
  const [cancelFor, setCancelFor] = useState<string | null>(null);
  const [merge, setMerge] = useState(false);

  const catalogs = useMemo(() => [...new Map(data.purchases.map((p) => [p.catalogId, `${p.house} · ${p.catalogNumber}`])).entries()], [data.purchases]);
  const rows = data.purchases.filter((p) => (!catalog || p.catalogId === catalog) && (!fin || p.financial === fin) && (!stage || (stage === "WAITING" ? p.stage !== "SHIPPED" && p.stage !== "DELIVERED" : p.stage === stage)));

  async function release(purchaseId: string, financial: string) {
    if (financial !== "PAID" && !perms.releaseUnpaid) return toast.error("הרכישה טרם שולמה במלואה. שחרור לפני תשלום דורש הרשאה מיוחדת");
    if (financial !== "PAID" && !window.confirm("הרכישה טרם שולמה במלואה. לשחרר לליקוט בכל זאת?")) return;
    try {
      await api(`/api/purchases/${purchaseId}/release`, { method: "POST" });
      toast.success("שוחרר לליקוט");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="space-y-6 px-4 pb-10 lg:px-8">
      <div className="grid grid-cols-2 divide-x-reverse divide-rule overflow-hidden rounded-xl border border-rule bg-paper shadow-card sm:grid-cols-3 lg:grid-cols-6" data-testid="customer-summary">
        <Stat label="לוטים שנרכשו" value={fmt.num(data.summary.lots)} sub={`${data.summary.books} ספרים`} />
        <Stat label="סכום רכישות (פטיש)" value={formatUsd(data.summary.hammerTotal)} />
        <Stat label="שולם" value={formatUsd(data.summary.paid, "$0")} tone="green" />
        <Stat label="יתרה פתוחה" value={formatUsd(data.summary.open, "$0")} tone={Number(data.summary.open) > 0 ? "danger" : undefined} />
        <Stat label="נשלחו" value={fmt.num(data.summary.shippedLots)} sub="לוטים" />
        <Stat label="צריך לשלוח" value={fmt.num(data.summary.toShipLots)} sub="לוטים" tone={data.summary.toShipLots ? "warn" : undefined} />
      </div>

      <div className="flex flex-wrap gap-2">
        {perms.ship && data.summary.toShipLots > 0 && (
          <Button variant="primary" icon={<PackageCheck />} onClick={() => setPrep("all")}>
            הכנה למשלוח
          </Button>
        )}
        {perms.edit && (
          <Button icon={<Pencil />} onClick={() => setEdit(true)}>
            עריכת פרטים
          </Button>
        )}
        {perms.edit && (
          <Button icon={<GitMerge />} onClick={() => setMerge(true)}>
            כפילות? איחוד לקוחות
          </Button>
        )}
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <Panel title="רכישות">
            <div className="flex flex-wrap gap-2 border-b border-rule px-4 py-3">
              <Select value={catalog} onChange={(e) => setCatalog(e.target.value)} aria-label="קטלוג" className="w-full sm:w-52">
                <option value="">כל המכירות</option>
                {catalogs.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </Select>
              <Select value={fin} onChange={(e) => setFin(e.target.value)} aria-label="מצב תשלום" className="w-full sm:w-44">
                <option value="">כל מצבי התשלום</option>
                <option value="UNPAID">ממתין לתשלום</option>
                <option value="PARTIAL">שולם חלקית</option>
                <option value="PAID">שולם</option>
              </Select>
              <Select value={stage} onChange={(e) => setStage(e.target.value)} aria-label="מצב משלוח" className="w-full sm:w-44">
                <option value="">כל מצבי המשלוח</option>
                <option value="WAITING">ממתין למשלוח</option>
                <option value="SHIPPED">נשלח</option>
                <option value="DELIVERED">נמסר</option>
              </Select>
            </div>
            {rows.length === 0 ? (
              <p className="px-4 py-6 text-center text-[13px] text-muted">אין רכישות</p>
            ) : (
              <ul className="divide-y divide-rule">
                {rows.map((p) => (
                  <li key={p.purchaseId} className="flex gap-3 px-4 py-3 text-[13.5px]">
                    <span className="block size-14 shrink-0 overflow-hidden rounded-md bg-stone ring-1 ring-rule">{p.thumbAssetId && <img src={`/api/assets/${p.thumbAssetId}/thumb`} alt="" loading="lazy" className="size-full object-cover" />}</span>
                    <div className="min-w-0 flex-1">
                      <Link href={`/lots/${p.lotId}`} className="block font-medium leading-snug hover:underline">
                        <span className="num me-1.5 rounded bg-stone px-1.5 text-[12.5px] font-semibold">{p.lotNumber}</span>
                        {p.title}
                      </Link>
                      <div className="text-[12px] text-muted">
                        {p.house}, קטלוג {p.catalogNumber} · {fmt.date(p.saleDate)}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span className="num font-semibold">{formatUsd(p.hammerPrice)}</span>
                        <FinancialBadge status={p.financial} />
                        <StageBadge stage={p.stage} released={p.released} />
                        {p.afterAuction && <Badge tone="info">לאחר המכרז</Badge>}
                        {p.shipmentNumber && (
                          <Link href={`/shipments/${p.shipmentId}`} className="text-[12px] underline">
                            משלוח {p.shipmentNumber}
                          </Link>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {perms.release && !p.released && p.stage === "IN_WAREHOUSE" && (
                        <Button size="sm" icon={<Send />} onClick={() => release(p.purchaseId, p.financial)}>
                          שחרור
                        </Button>
                      )}
                      {perms.cancel && p.stage !== "SHIPPED" && p.stage !== "DELIVERED" && (
                        <Button size="sm" variant="danger" icon={<Ban />} onClick={() => setCancelFor(p.purchaseId)}>
                          ביטול עסקה
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="תשלומים והזמנות">
            {data.orders.length === 0 ? (
              <p className="px-4 py-6 text-center text-[13px] text-muted">אין הזמנות</p>
            ) : (
              <div className="divide-y divide-rule">
                {data.orders.map((o) => (
                  <div key={o.id} className="px-4 py-3 text-[13.5px]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="font-medium">
                          {o.house}, קטלוג {o.catalogNumber}
                        </span>{" "}
                        <span className="text-muted">{o.catalogName}</span>
                      </div>
                      <FinancialBadge status={o.ledger.status} />
                    </div>
                    <div className="num mt-1 text-[12.5px] text-ink-2">
                      לחיוב {formatUsd(o.ledger.charge, "$0")} · שולם {formatUsd(o.ledger.paid, "$0")} · יתרה <b className={Number(o.ledger.due) > 0 ? "text-danger" : ""}>{formatUsd(o.ledger.due, "$0")}</b>
                      {o.ledger.incomplete && <span className="text-muted"> (עמלה או מס לא הוגדרו, הסכום חלקי)</span>}
                      {o.ledger.overpaid && <span className="text-warn"> · שולם ביתר {formatUsd(o.ledger.overpaid)}</span>}
                    </div>
                    {o.payments.length > 0 && (
                      <ul className="mt-2 space-y-1 text-[12.5px]">
                        {o.payments.map((p) => (
                          <li key={p.id} className={p.status === "VOIDED" ? "text-faint line-through" : ""}>
                            <span className="num">{formatUsd(p.amount)}</span> · {fmt.date(p.paidAt)} {p.method ? `· ${p.method}` : ""} {p.reference ? `· אסמכתה ${p.reference}` : ""}
                            {p.status === "RECORDED" && perms.payment && (
                              <button
                                type="button"
                                className="ms-2 text-danger underline"
                                onClick={async () => {
                                  const reason = window.prompt("סיבת ביטול התשלום");
                                  if (!reason) return;
                                  try {
                                    await api(`/api/payments/${p.id}/void`, { method: "POST", json: { reason } });
                                    router.refresh();
                                  } catch (err) {
                                    toast.error(errorMessage(err));
                                  }
                                }}
                              >
                                ביטול
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {perms.payment && (
                      <Button size="sm" icon={<CreditCard />} className="mt-2" onClick={() => setPayFor(o.id)}>
                        רישום תשלום
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="משלוחים">
            {data.shipments.length === 0 ? (
              <p className="px-4 py-6 text-center text-[13px] text-muted">עדיין לא נוצרו משלוחים</p>
            ) : (
              <ul className="divide-y divide-rule">
                {data.shipments.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-[13.5px]">
                    <Link href={`/shipments/${s.id}`} className="font-medium hover:underline">
                      משלוח {s.number}
                    </Link>
                    <span className="num text-muted">
                      {s.lots} לוטים · {s.books} ספרים
                    </span>
                    <ShipmentBadge status={s.status} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="פרטים">
            <dl className="space-y-2 px-4 py-3 text-[13.5px]">
              <Row k="אימייל" v={c.email} ltr />
              <Row k="טלפון" v={c.phone} ltr />
              <Row k="כתובות" v={c.addresses.map((a) => [a.line1, a.city, a.country].filter(Boolean).join(", ")).join(" | ") || null} />
              <Row k="מזהים חיצוניים" v={c.identities.map((i) => `${i.system} ${i.kind === "BUYER_ID" ? "מזהה קונה" : "מספר מציע במכירה"}: ${i.externalId}`).join(" | ") || null} />
              <Row k="הערות" v={c.notes} />
              <Row k="פעילות מ-" v={data.summary.firstSale ? fmt.date(data.summary.firstSale) : null} />
              {c.needsDetails && <Badge tone="warn">הלקוח נוצר מקובץ עם פרטים חלקיים. נא להשלים פרטים</Badge>}
            </dl>
          </Panel>
          <Panel title="היסטוריה">
            <ul className="divide-y divide-rule text-[12.5px]">
              {data.events.map((e) => (
                <li key={e.id} className="px-4 py-2">
                  <span className="font-medium">{EVENT[e.kind] ?? e.kind}</span> <span className="text-muted">{fmt.dateTime(e.at)}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>

      {prep && <PrepareShipmentDialog open onClose={() => setPrep(null)} customerId={c.id} customerName={c.name} />}
      {edit && <EditDialog data={data} onClose={() => setEdit(false)} />}
      {payFor && <PaymentDialog orderId={payFor} onClose={() => setPayFor(null)} />}
      {cancelFor && <CancelDialog purchaseId={cancelFor} onClose={() => setCancelFor(null)} />}
      {merge && <MergeDialog customerId={c.id} onClose={() => setMerge(false)} />}
    </div>
  );
}

function Row({ k, v, ltr }: { k: string; v: string | null | undefined; ltr?: boolean }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-muted">{k}</dt>
      <dd className="min-w-0 flex-1 break-words" dir={ltr ? "ltr" : undefined}>
        <span className={ltr ? "block text-start" : undefined}>{v || "—"}</span>
      </dd>
    </div>
  );
}

function EditDialog({ data, onClose }: { data: Data; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const c = data.customer;
  const a = c.addresses[0];
  const [d, setD] = useState({ name: c.name, email: c.email ?? "", phone: c.phone ?? "", line1: a?.line1 ?? "", city: a?.city ?? "", country: a?.country ?? "", notes: c.notes ?? "" });
  async function save() {
    try {
      await api(`/api/customers/${c.id}`, {
        method: "PATCH",
        json: { name: d.name, email: d.email || null, phone: d.phone || null, notes: d.notes || null, addresses: d.line1.trim() ? [{ ...(a ?? {}), line1: d.line1, city: d.city || undefined, country: d.country || undefined }, ...c.addresses.slice(1)] : c.addresses.slice(1) },
      });
      toast.success("הפרטים נשמרו");
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  return (
    <Dialog open onClose={onClose} title="עריכת פרטי לקוח" footer={<><Button onClick={onClose}>ביטול</Button><Button variant="primary" onClick={save}>שמירה</Button></>}>
      <div className="space-y-3">
        <Field label="שם">{(p) => <Input {...p} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="אימייל">{(p) => <Input {...p} dir="ltr" value={d.email} onChange={(e) => setD({ ...d, email: e.target.value })} />}</Field>
          <Field label="טלפון">{(p) => <Input {...p} dir="ltr" value={d.phone} onChange={(e) => setD({ ...d, phone: e.target.value })} />}</Field>
        </div>
        <Field label="כתובת">{(p) => <Input {...p} value={d.line1} onChange={(e) => setD({ ...d, line1: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="עיר">{(p) => <Input {...p} value={d.city} onChange={(e) => setD({ ...d, city: e.target.value })} />}</Field>
          <Field label="מדינה">{(p) => <Input {...p} value={d.country} onChange={(e) => setD({ ...d, country: e.target.value })} />}</Field>
        </div>
        <Field label="הערות">{(p) => <Textarea {...p} value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} />}</Field>
      </div>
    </Dialog>
  );
}

function PaymentDialog({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [d, setD] = useState({ amount: "", method: "", reference: "", date: new Date().toISOString().slice(0, 10) });
  async function save() {
    let amount: string | null;
    try {
      amount = parseUsd(d.amount);
    } catch (e) {
      return toast.error((e as Error).message);
    }
    if (!amount) return toast.error("יש להזין סכום");
    try {
      await api(`/api/orders/${orderId}/payments`, { method: "POST", json: { amount, method: d.method || null, reference: d.reference || null, paidAt: d.date } });
      toast.success("התשלום נרשם");
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  return (
    <Dialog open onClose={onClose} title="רישום תשלום" description="התשלום נרשם בדולרים ומשויך להזמנה. תשלום חלקי אפשרי." footer={<><Button onClick={onClose}>ביטול</Button><Button variant="primary" onClick={save}>רישום</Button></>}>
      <div className="space-y-3">
        <Field label="סכום (דולר)">{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={d.amount} onChange={(e) => setD({ ...d, amount: e.target.value })} className="w-40" />}</Field>
        <Field label="תאריך">{(p) => <Input {...p} type="date" value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} className="w-44" />}</Field>
        <Field label="אמצעי תשלום">{(p) => <Input {...p} value={d.method} onChange={(e) => setD({ ...d, method: e.target.value })} placeholder="העברה, כרטיס אשראי, מזומן…" />}</Field>
        <Field label="אסמכתה">{(p) => <Input {...p} value={d.reference} onChange={(e) => setD({ ...d, reference: e.target.value })} />}</Field>
      </div>
    </Dialog>
  );
}

function CancelDialog({ purchaseId, onClose }: { purchaseId: string; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [refund, setRefund] = useState("");
  async function go() {
    try {
      await api(`/api/purchases/${purchaseId}/cancel`, { method: "POST", json: { reason, refundNote: refund || null } });
      toast.success("העסקה בוטלה ונשמרה בהיסטוריה");
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  return (
    <Dialog open onClose={onClose} title="ביטול עסקה" description="העסקה לא נמחקת: היא נשמרת עם הקונה, המחיר, הסיבה ומי ביטל. הספר יחזור להיות זמין לשיוך." footer={<><Button onClick={onClose}>חזרה</Button><Button variant="danger" disabled={reason.trim().length < 2} onClick={go}>ביטול העסקה</Button></>}>
      <div className="space-y-3">
        <Field label="סיבת הביטול" required>{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <Field label="החזר כספי (הערה חופשית)">{(p) => <Input {...p} value={refund} onChange={(e) => setRefund(e.target.value)} placeholder="אם שולם: איך הוחזר" />}</Field>
      </div>
    </Dialog>
  );
}

function MergeDialog({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [cands, setCands] = useState<{ id: string; number: number; name: string; email: string | null; phone: string | null; sameName: boolean; sameEmail: boolean; samePhone: boolean }[] | null>(null);
  useEffect(() => {
    api<{ candidates: NonNullable<typeof cands> }>(`/api/customers/${customerId}/merge`).then((r) => setCands(r.candidates)).catch((e) => toast.error(errorMessage(e)));
  }, [customerId, toast]);
  async function merge(intoId: string, name: string) {
    if (!window.confirm(`למזג את הלקוח הזה אל "${name}"? כל הרכישות, התשלומים והמשלוחים יעברו אליו, והמיזוג יתועד. הפעולה לא מוחקת היסטוריה.`)) return;
    try {
      await api(`/api/customers/${customerId}/merge`, { method: "POST", json: { intoId } });
      toast.success("הלקוחות אוחדו");
      router.push(`/customers/${intoId}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  return (
    <Dialog open onClose={onClose} title="איחוד לקוחות" description="לקוחות נמצאים כאן לפי אימייל, טלפון או שם זהה. שם זהה בלבד אינו הוכחה שמדובר באותו אדם. הבחירה היא שלך." footer={<Button onClick={onClose}>סגירה</Button>}>
      {cands === null ? (
        <p className="py-4 text-center text-muted">טוען…</p>
      ) : cands.length === 0 ? (
        <p className="py-4 text-center text-muted">לא נמצאו לקוחות דומים</p>
      ) : (
        <ul className="divide-y divide-rule rounded-lg border border-rule">
          {cands.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-[13.5px]">
              <div>
                <Link href={`/customers/${c.id}`} className="font-medium hover:underline">
                  {c.name}
                </Link>{" "}
                <span className="num text-muted">#{c.number}</span>
                <div className="text-[12px] text-muted">
                  {[c.sameEmail && "אותו אימייל", c.samePhone && "אותו טלפון", c.sameName && "אותו שם"].filter(Boolean).join(" · ")}
                </div>
              </div>
              <Button size="sm" onClick={() => merge(c.id, c.name)}>
                מיזוג אל לקוח זה
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
