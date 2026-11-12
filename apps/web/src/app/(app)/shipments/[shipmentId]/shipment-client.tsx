"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ban, Box, PackageCheck, Plus, Truck, Undo2 } from "lucide-react";
import type { getShipment } from "@/server/services/shipments";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { Panel } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { METHOD_LABEL, STAGE_LABEL } from "@/components/sales/status";
import { PrepareShipmentDialog } from "@/components/sales/prepare-shipment-dialog";
import { ApiError, api, errorMessage } from "@/lib/api";
import { parseUsd } from "@/lib/money";
import { fmt } from "@/i18n";

type S = Awaited<ReturnType<typeof getShipment>>;

export function ShipmentClient({ s, perms }: { s: S; perms: { status: boolean; prepare: boolean; customers: boolean } }) {
  const router = useRouter();
  const toast = useToast();
  const [ship, setShip] = useState(false);
  const [adding, setAdding] = useState(false);
  const [returning, setReturning] = useState<string | null>(null);
  const [partial, setPartial] = useState<number | null>(null);
  const [d, setD] = useState({ carrier: s.carrier ?? "", tracking: s.trackingNumber ?? "", cost: s.cost ?? "" });
  const active = s.items.filter((i) => i.active);
  const lots = [...new Map(active.map((i) => [i.purchaseId, i])).values()];

  async function act(path: string, body?: unknown, ok?: string) {
    try {
      await api(`/api/shipments/${s.id}/${path}`, { method: "POST", json: body ?? {} });
      if (ok) toast.success(ok);
      router.refresh();
      return true;
    } catch (err) {
      if (err instanceof ApiError && (err.details as { code?: string } | undefined)?.code === "PARTIAL_SHIPMENT") setPartial((err.details as { remainingLots: number }).remainingLots);
      else toast.error(errorMessage(err));
      return false;
    }
  }

  async function sendNow(confirmPartial?: boolean) {
    let cost: string | null = null;
    try {
      cost = d.cost ? parseUsd(d.cost, { allowZero: true }) : null;
    } catch (e) {
      return toast.error((e as Error).message);
    }
    if (await act("ship", { carrier: d.carrier || null, trackingNumber: d.tracking || null, cost, confirmPartial }, s.method === "CARRIER" ? "המשלוח סומן כנשלח" : "הספרים נמסרו ללקוח")) {
      setShip(false);
      setPartial(null);
    }
  }

  return (
    <div className="grid items-start gap-6 px-4 pb-10 lg:px-8 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Panel title={`ספרים במשלוח (${active.length})`}>
        <ul className="divide-y divide-rule">
          {s.items.map((i) => (
            <li key={i.id} className={`flex gap-3 px-4 py-3 text-[13.5px] ${i.active ? "" : "opacity-60"}`}>
              <span className="block size-12 shrink-0 overflow-hidden rounded bg-stone ring-1 ring-rule">{i.thumbAssetId && <img src={`/api/assets/${i.thumbAssetId}/thumb`} alt="" loading="lazy" className="size-full object-cover" />}</span>
              <div className="min-w-0 flex-1">
                <Link href={`/lots/${i.lotId}`} className="font-medium hover:underline">
                  <span className="num me-1 font-semibold">{i.lotNumber}</span> {i.title}
                </Link>
                <div className="num font-mono text-[11.5px] text-muted">
                  {i.inventoryNumber} · קטלוג {i.catalogNumber}
                </div>
                <div className="text-[12px] text-ink-2">{i.active ? STAGE_LABEL[({ SHIPPED: "SHIPPED", PACKED: "PACKED", PICKED: "PICKED", AWAITING_PICK: "AWAITING_PICK" } as Record<string, string>)[i.physicalStatus] ?? "IN_WAREHOUSE"] : i.returnedAt ? `הוחזר: ${i.returnReason}` : `הוצא: ${i.removeReason ?? ""}`}</div>
              </div>
              {i.active && perms.status && (s.status === "SHIPPED" || s.status === "DELIVERED") && (
                <Button size="sm" icon={<Undo2 />} onClick={() => setReturning(i.itemId)}>
                  החזרה
                </Button>
              )}
              {i.active && perms.prepare && (s.status === "DRAFT" || s.status === "PACKED") && lots.length > 1 && (
                <Button size="sm" variant="ghost" onClick={() => act("remove", { purchaseId: i.purchaseId, reason: "הוצא מהמשלוח" }, "הלוט הוצא מהמשלוח")}>
                  הוצאה
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Panel>

      <div className="space-y-4">
        <Panel title="נמען וחברת משלוחים">
          <dl className="space-y-1.5 px-4 py-3 text-[13.5px]">
            <div>
              <dt className="inline text-muted">נמען: </dt>
              <dd className="inline">{s.recipient.name}</dd>
            </div>
            <div>
              <dt className="inline text-muted">כתובת: </dt>
              <dd className="inline">{s.recipient.address ?? "לא הוגדרה"}</dd>
            </div>
            <div>
              <dt className="inline text-muted">טלפון: </dt>
              <dd className="inline" dir="ltr">{s.recipient.phone ?? "—"}</dd>
            </div>
            <div>
              <dt className="inline text-muted">שיטת מסירה: </dt>
              <dd className="inline">{METHOD_LABEL[s.method]}</dd>
            </div>
            {s.carrier && <div><dt className="inline text-muted">חברה: </dt><dd className="inline">{s.carrier}</dd></div>}
            {s.trackingNumber && <div><dt className="inline text-muted">מספר מעקב: </dt><dd className="num inline">{s.trackingNumber}</dd></div>}
            {s.cost && <div><dt className="inline text-muted">עלות: </dt><dd className="num inline">${s.cost}</dd></div>}
            {s.partialConfirmed && <Badge tone="warn">משלוח חלקי, אושר</Badge>}
            <div className="pt-1 text-[12px] text-muted">
              נוצר {fmt.dateTime(s.createdAt)}
              {s.packedAt && ` · נארז ${fmt.dateTime(s.packedAt)}`}
              {s.shippedAt && ` · יצא ${fmt.dateTime(s.shippedAt)}`}
              {s.deliveredAt && ` · נמסר ${fmt.dateTime(s.deliveredAt)}`}
              {s.cancelledAt && ` · בוטל ${fmt.dateTime(s.cancelledAt)}: ${s.cancelReason ?? ""}`}
            </div>
          </dl>
        </Panel>

        <div className="flex flex-wrap gap-2">
          {perms.prepare && s.status === "DRAFT" && (
            <>
              <Button icon={<Plus />} onClick={() => setAdding(true)}>
                הוספת פריטים
              </Button>
              <Button variant="primary" icon={<Box />} onClick={() => act("pack", {}, "המשלוח נארז")}>
                סימון כנארז
              </Button>
            </>
          )}
          {perms.status && s.status === "PACKED" && (
            <Button variant="primary" icon={<Truck />} onClick={() => setShip(true)}>
              {s.method === "CARRIER" ? "יציאה / שליחה" : "מסירה ללקוח"}
            </Button>
          )}
          {perms.status && s.status === "SHIPPED" && (
            <Button variant="primary" icon={<PackageCheck />} onClick={() => act("deliver", {}, "המשלוח סומן כנמסר")}>
              סימון כנמסר
            </Button>
          )}
          {perms.status && (s.status === "DRAFT" || s.status === "PACKED") && (
            <Button
              variant="danger"
              icon={<Ban />}
              onClick={async () => {
                const reason = window.prompt("סיבת ביטול המשלוח");
                if (reason) await act("cancel", { reason }, "המשלוח בוטל");
              }}
            >
              ביטול משלוח
            </Button>
          )}
        </div>
        {s.status === "DRAFT" && <p className="text-[12.5px] text-muted">יצירת משלוח אינה מסמנת את הספרים כנשלחו. אריזה אפשרית אחרי ליקוט (במסופון), ו״נשלח״ נרשם רק ביציאה הפיזית.</p>}
      </div>

      <Dialog
        open={ship}
        onClose={() => {
          setShip(false);
          setPartial(null);
        }}
        title={s.method === "CARRIER" ? "יציאת המשלוח" : "מסירה ללקוח"}
        footer={
          partial === null ? (
            <>
              <Button onClick={() => setShip(false)}>ביטול</Button>
              <Button variant="primary" onClick={() => sendNow()}>
                {s.method === "CARRIER" ? "הספרים יצאו" : "הספרים נמסרו"}
              </Button>
            </>
          ) : undefined
        }
      >
        {partial !== null ? (
          <div role="alert" className="space-y-3">
            <p className="rounded-lg bg-warn-soft px-4 py-3 text-[14px] text-warn">אתה עומד לשלוח רק חלק מהרכישות: ללקוח יש עוד {partial} לוטים שעדיין לא נשלחו.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => setPartial(null)}>
                חזרה
              </Button>
              {perms.customers && (
                <Link href={`/customers/${s.customer.id}`} className="inline-flex h-9 items-center rounded-md border border-rule-strong px-3.5 text-[13.5px] font-medium">
                  צפייה ברשימת הרכישות
                </Link>
              )}
              <Button onClick={() => sendNow(true)}>המשך משלוח חלקי</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {s.method === "CARRIER" && (
              <>
                <Field label="חברת משלוחים">{(p) => <Input {...p} value={d.carrier} onChange={(e) => setD({ ...d, carrier: e.target.value })} />}</Field>
                <Field label="מספר מעקב">{(p) => <Input {...p} dir="ltr" value={d.tracking} onChange={(e) => setD({ ...d, tracking: e.target.value })} />}</Field>
                <Field label="עלות משלוח (דולר, לא חובה)">{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={d.cost} onChange={(e) => setD({ ...d, cost: e.target.value })} className="w-36" />}</Field>
              </>
            )}
            <p className="text-[12.5px] text-muted">אשרו רק אחרי שהספרים יצאו פיזית מהמחסן.</p>
          </div>
        )}
      </Dialog>
      {adding && <PrepareShipmentDialog open onClose={() => setAdding(false)} customerId={s.customer.id} customerName={s.customer.name} addToShipmentId={s.id} />}
      {returning && <ReturnDialog shipmentId={s.id} itemId={returning} onClose={() => setReturning(null)} />}
    </div>
  );
}

function ReturnDialog({ shipmentId, itemId, onClose }: { shipmentId: string; itemId: string; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [d, setD] = useState({ reason: "", condition: "" });
  async function go() {
    try {
      await api(`/api/shipments/${shipmentId}/return`, { method: "POST", json: { itemId, reason: d.reason, condition: d.condition || null } });
      toast.success("הספר הוחזר. הוא ממתין לשיבוץ במדף, והעסקה ממתינה לשחרור מחדש");
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  return (
    <Dialog open onClose={onClose} title="החזרת ספר למחסן" description="נתוני המשלוח המקורי נשמרים. הספר יחזור למחסן ויחכה לשיבוץ במדף." footer={<><Button onClick={onClose}>ביטול</Button><Button variant="primary" disabled={d.reason.trim().length < 2} onClick={go}>רישום החזרה</Button></>}>
      <div className="space-y-3">
        <Field label="סיבת ההחזרה" required>{(p) => <Input {...p} value={d.reason} onChange={(e) => setD({ ...d, reason: e.target.value })} />}</Field>
        <Field label="מצב הפריט">{(p) => <Input {...p} value={d.condition} onChange={(e) => setD({ ...d, condition: e.target.value })} placeholder="תקין, פגום…" />}</Field>
      </div>
    </Dialog>
  );
}
