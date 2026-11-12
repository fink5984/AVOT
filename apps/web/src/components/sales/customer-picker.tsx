"use client";

import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { api, errorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/toast";

export interface PickedCustomer {
  id: string;
  name: string;
  number: number;
  email?: string | null;
  phone?: string | null;
}

/** Find a customer by name / e-mail / phone / number, or create one on the spot. Never matches by name alone on the server side. */
export function CustomerPicker({ value, onChange }: { value: PickedCustomer | null; onChange: (c: PickedCustomer | null) => void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<PickedCustomer[]>([]);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: "", email: "", phone: "" });

  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    const h = setTimeout(async () => {
      try {
        setFound((await api<{ customers: PickedCustomer[] }>(`/api/customers?q=${encodeURIComponent(q.trim())}`)).customers.slice(0, 8));
      } catch {
        setFound([]);
      }
    }, 250);
    return () => clearTimeout(h);
  }, [q]);

  async function create() {
    try {
      const r = await api<{ customer: PickedCustomer }>("/api/customers", { method: "POST", json: { name: draft.name, email: draft.email || null, phone: draft.phone || null } });
      onChange(r.customer);
      setCreating(false);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-rule bg-stone-2 px-3 py-2 text-[13.5px]">
        <span>
          <span className="font-medium">{value.name}</span> <span className="num text-muted">#{value.number}</span>
        </span>
        <button type="button" className="text-[12.5px] text-muted hover:text-ink" onClick={() => onChange(null)}>
          החלפה
        </button>
      </div>
    );
  }
  if (creating) {
    return (
      <div className="space-y-2 rounded-md border border-rule p-3">
        <Input placeholder="שם הלקוח" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="שם הלקוח" />
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder="אימייל" dir="ltr" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} aria-label="אימייל" />
          <Input placeholder="טלפון" dir="ltr" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} aria-label="טלפון" />
        </div>
        <p className="text-[12px] text-muted">שם בלבד אינו מזהה לקוח. מומלץ למלא אימייל או טלפון, כדי שהמערכת תזהה את הלקוח ברכישות הבאות.</p>
        <div className="flex gap-2">
          <Button variant="primary" size="sm" disabled={!draft.name.trim()} onClick={create}>
            יצירת לקוח
          </Button>
          <Button size="sm" onClick={() => setCreating(false)}>
            ביטול
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש לקוח: שם, אימייל, טלפון או מספר" className="ps-9" aria-label="חיפוש לקוח" />
      </div>
      {found.length > 0 && (
        <ul className="divide-y divide-rule rounded-md border border-rule">
          {found.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onChange(c)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-[13.5px] hover:bg-stone-2">
                <span className="font-medium">{c.name}</span>
                <span className="num text-[12px] text-muted">
                  #{c.number} {c.email ?? c.phone ?? ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button size="sm" icon={<Plus />} onClick={() => setCreating(true)}>
        לקוח חדש
      </Button>
    </div>
  );
}
