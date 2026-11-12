"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, errorMessage } from "@/lib/api";
import { formatUsd } from "@/lib/money";

interface Row {
  id: string;
  number: number;
  name: string;
  email: string | null;
  phone: string | null;
  needsDetails: boolean;
  external: string[];
  sales: number;
  lots: number;
  hammerTotal: string;
  paid: string;
  open: string;
  waitingLots: number;
}

export function CustomersClient({ rows, q, filter, canEdit }: { rows: Row[]; q: string; filter: string; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [d, setD] = useState({ name: "", email: "", phone: "" });
  const [dup, setDup] = useState<string[] | null>(null);

  async function create() {
    try {
      const r = await api<{ customer: { id: string } }>("/api/customers", { method: "POST", json: { name: d.name, email: d.email || null, phone: d.phone || null } });
      setAdding(false);
      router.push(`/customers/${r.customer.id}`);
    } catch (err) {
      if (err instanceof ApiError && (err.details as { code?: string } | undefined)?.code === "DUPLICATE_CUSTOMER") setDup((err.details as { customerIds: string[] }).customerIds);
      else toast.error(errorMessage(err));
    }
  }

  return (
    <>
      <form action="/customers" className="mb-4 flex flex-wrap items-center gap-2">
        <Input type="search" name="q" defaultValue={q} placeholder="חיפוש: שם, אימייל, טלפון, מספר לקוח או מזהה חיצוני" aria-label="חיפוש לקוחות" className="min-w-0 flex-1 sm:w-96 sm:flex-none" />
        <Select name="filter" defaultValue={filter} aria-label="סינון" className="w-full sm:w-52">
          <option value="all">כל הלקוחות</option>
          <option value="owing">עם יתרה פתוחה</option>
          <option value="waiting">עם פריטים הממתינים למשלוח</option>
          <option value="needsDetails">דורשים השלמת פרטים</option>
        </Select>
        <Button type="submit" variant="primary">
          חיפוש
        </Button>
        {canEdit && (
          <Button icon={<Plus />} onClick={() => setAdding(true)} className="sm:ms-auto">
            לקוח חדש
          </Button>
        )}
      </form>

      {rows.length === 0 ? (
        <EmptyState title="אין לקוחות">לקוחות נוצרים אוטומטית בייבוא תוצאות מכירה, או ידנית מכאן.</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border border-rule bg-paper shadow-card">
          <ul className="divide-y divide-rule md:hidden">
            {rows.map((c) => (
              <li key={c.id}>
                <Link href={`/customers/${c.id}`} className="block px-3.5 py-3 text-[13.5px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{c.name}</span>
                    <span className="num text-[12px] text-muted">#{c.number}</span>
                  </div>
                  <div className="text-[12.5px] text-muted">{[c.email, c.phone].filter(Boolean).join(" · ") || "אין פרטי קשר"}</div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px]">
                    <span><span className="num">{c.lots}</span> לוטים</span>
                    <span className="num">{formatUsd(c.hammerTotal)}</span>
                    {Number(c.open) > 0 && <span className="font-medium text-danger">יתרה {formatUsd(c.open)}</span>}
                    {c.waitingLots > 0 && <span className="text-warn">{c.waitingLots} ממתינים למשלוח</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <table className="hidden w-full text-[13.5px] md:table">
            <thead>
              <tr className="border-b border-rule bg-stone-2/60 text-[12.5px] text-muted">
                <th className="px-3 py-3 text-start font-medium">לקוח</th>
                <th className="px-3 py-3 text-start font-medium">פרטי קשר</th>
                <th className="px-3 py-3 text-start font-medium">מזהים חיצוניים</th>
                <th className="px-3 py-3 text-start font-medium">מכירות</th>
                <th className="px-3 py-3 text-start font-medium">לוטים</th>
                <th className="px-3 py-3 text-start font-medium">סכום פטיש</th>
                <th className="px-3 py-3 text-start font-medium">יתרה פתוחה</th>
                <th className="px-3 py-3 text-start font-medium">ממתינים למשלוח</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {rows.map((c) => (
                <tr key={c.id} className="hover:bg-stone-2/40">
                  <td className="px-3 py-2.5">
                    <Link href={`/customers/${c.id}`} className="font-medium hover:underline">
                      {c.name}
                    </Link>
                    <span className="num ms-2 text-[12px] text-muted">#{c.number}</span>
                    {c.needsDetails && <Badge tone="warn" className="ms-2">דורש השלמת פרטים</Badge>}
                  </td>
                  <td className="px-3 py-2.5 text-[12.5px]" dir="ltr">
                    <div className="text-start">{c.email}</div>
                    <div className="text-start text-muted">{c.phone}</div>
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-muted">{c.external.join(", ")}</td>
                  <td className="num px-3 py-2.5">{c.sales}</td>
                  <td className="num px-3 py-2.5">{c.lots}</td>
                  <td className="num px-3 py-2.5">{formatUsd(c.hammerTotal, "—")}</td>
                  <td className={`num px-3 py-2.5 ${Number(c.open) > 0 ? "font-semibold text-danger" : ""}`}>{formatUsd(c.open, "—")}</td>
                  <td className="num px-3 py-2.5">{c.waitingLots || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={adding}
        onClose={() => {
          setAdding(false);
          setDup(null);
        }}
        title="לקוח חדש"
        footer={
          <>
            <Button onClick={() => setAdding(false)}>ביטול</Button>
            <Button variant="primary" disabled={!d.name.trim()} onClick={create}>
              יצירה
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="שם">{(p) => <Input {...p} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />}</Field>
          <Field label="אימייל">{(p) => <Input {...p} dir="ltr" value={d.email} onChange={(e) => setD({ ...d, email: e.target.value })} />}</Field>
          <Field label="טלפון">{(p) => <Input {...p} dir="ltr" value={d.phone} onChange={(e) => setD({ ...d, phone: e.target.value })} />}</Field>
          {dup && (
            <p role="alert" className="rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">
              כבר קיים לקוח עם אותו אימייל או טלפון.{" "}
              {dup.map((id) => (
                <Link key={id} href={`/customers/${id}`} className="font-medium underline">
                  פתיחת הלקוח
                </Link>
              ))}
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}
