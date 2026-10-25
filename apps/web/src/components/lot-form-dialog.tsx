"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PHOTO_CATEGORIES, type CategoryRequirements } from "@avot/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { t } from "@/i18n";
import { api, errorMessage } from "@/lib/api";

export interface LotFormValue {
  id?: string;
  lotNumber?: number;
  title: string;
  subtitle: string | null;
  author: string | null;
  printYear: string | null;
  printPlace: string | null;
  shortDescription: string | null;
  /** long catalog description; every change is kept as a version */
  description?: string | null;
  internalNotes: string | null;
  requirements?: CategoryRequirements;
}

export function LotFormDialog({
  open,
  onClose,
  catalogId,
  initial,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  catalogId: string;
  initial?: LotFormValue;
  onSaved?: (lot: { id: string; lotNumber: number }) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = !!initial?.id;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const str = (k: string) => String(f.get(k) ?? "").trim() || null;
    const num = String(f.get("lotNumber") ?? "").trim();
    const requirements = Object.fromEntries(
      PHOTO_CATEGORIES.map((c) => [c, { required: f.get(`req-${c}`) === "on", min: Math.max(0, Number(f.get(`min-${c}`) ?? 0) || 0) }]),
    );
    const body = {
      ...(num ? { lotNumber: Number(num) } : {}),
      title: str("title") ?? "",
      subtitle: str("subtitle"),
      author: str("author"),
      printYear: str("printYear"),
      printPlace: str("printPlace"),
      shortDescription: str("shortDescription"),
      description: str("description"),
      internalNotes: str("internalNotes"),
      requirements,
    };
    setSaving(true);
    setError(null);
    try {
      const r = editing
        ? await api<{ lot: { id: string; lotNumber: number } }>(`/api/lots/${initial!.id}`, { method: "PATCH", json: body })
        : await api<{ lot: { id: string; lotNumber: number } }>(`/api/catalogs/${catalogId}/lots`, { method: "POST", json: body });
      toast.success(editing ? "פרטי הפריט נשמרו" : `נוצר פריט מספר ${r.lot.lotNumber}`);
      onSaved?.(r.lot);
      onClose();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const req = initial?.requirements;

  return (
    <Dialog open={open} onClose={onClose} title={editing ? `עריכת פריט ${initial?.lotNumber}` : "פריט חדש"} width="lg">
      <form
        id="lot-form"
        onSubmit={submit}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            e.currentTarget.requestSubmit();
          }
        }}
        className="grid grid-cols-6 gap-x-3 gap-y-4"
      >
        <Field label="מספר" hint={editing ? undefined : "ריק = אוטומטי"} className="col-span-2 sm:col-span-1">
          {(p) => <Input {...p} name="lotNumber" type="number" min={1} defaultValue={initial?.lotNumber} className="num text-start" />}
        </Field>
        <Field label="שם הספר" required className="col-span-4 sm:col-span-5">
          {(p) => <Input {...p} name="title" required maxLength={300} defaultValue={initial?.title} autoFocus />}
        </Field>
        <Field label="כותרת משנה" className="col-span-6">
          {(p) => <Input {...p} name="subtitle" maxLength={300} defaultValue={initial?.subtitle ?? ""} />}
        </Field>
        <Field label="מחבר" className="col-span-6 sm:col-span-2">
          {(p) => <Input {...p} name="author" maxLength={200} defaultValue={initial?.author ?? ""} />}
        </Field>
        <Field label="שנת דפוס" className="col-span-3 sm:col-span-2">
          {(p) => <Input {...p} name="printYear" maxLength={50} defaultValue={initial?.printYear ?? ""} placeholder='למשל: תקמ"ח / 1788' />}
        </Field>
        <Field label="מקום דפוס" className="col-span-3 sm:col-span-2">
          {(p) => <Input {...p} name="printPlace" maxLength={200} defaultValue={initial?.printPlace ?? ""} />}
        </Field>
        <Field label="תיאור קצר" className="col-span-6">
          {(p) => <Textarea {...p} name="shortDescription" rows={2} maxLength={2000} defaultValue={initial?.shortDescription ?? ""} />}
        </Field>
        <Field label="תיאור מלא לקטלוג" hint="ייחודי לקטלוג זה; כל שינוי נשמר כגרסה" className="col-span-6">
          {(p) => <Textarea {...p} name="description" rows={4} maxLength={20000} defaultValue={initial?.description ?? ""} />}
        </Field>
        <Field label="הערות פנימיות" className="col-span-6">
          {(p) => <Textarea {...p} name="internalNotes" rows={2} maxLength={5000} defaultValue={initial?.internalNotes ?? ""} />}
        </Field>
        <fieldset className="col-span-6 rounded-lg bg-stone-2 px-4 pb-3.5 pt-3 ring-1 ring-rule">
          <legend className="sr-only">דרישות צילום</legend>
          <div className="mb-2.5 text-[13px] font-medium text-ink-2">דרישות צילום (מינימום תמונות לכל קטגוריה)</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            {PHOTO_CATEGORIES.map((c) => (
              <div key={c} className="flex items-center gap-2 text-[13px]">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" name={`req-${c}`} defaultChecked={req ? req[c].required : c !== "EXTERIOR"} className="accent-[var(--color-ink)]" />
                  {t.categoryShort[c]}
                </label>
                <span className="text-[11.5px] text-muted">מינ׳</span>
                <input
                  type="number"
                  name={`min-${c}`}
                  min={0}
                  max={500}
                  defaultValue={req ? req[c].min : c === "EXTERIOR" ? 0 : 1}
                  className="num h-8 w-14 rounded-md border border-rule-strong bg-paper px-2 text-start text-[13px]"
                  aria-label={`מינימום תמונות — ${t.category[c]}`}
                />
              </div>
            ))}
          </div>
        </fieldset>
        {error && (
          <p className="col-span-6 rounded-md bg-danger-soft px-3 py-2.5 text-[13px] text-danger" role="alert">
            {error}
          </p>
        )}
      </form>
      <div className="mt-6 flex items-center gap-2">
        <Button type="submit" form="lot-form" variant="primary" loading={saving}>
          {editing ? "שמירה" : "הוספת פריט"}
        </Button>
        <Button onClick={onClose}>ביטול</Button>
        <span className="ms-auto text-[11.5px] text-faint">Ctrl+S לשמירה</span>
      </div>
    </Dialog>
  );
}
