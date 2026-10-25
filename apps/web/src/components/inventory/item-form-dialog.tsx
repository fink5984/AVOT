"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BOOK_SIZES, type BookSize } from "@avot/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { t } from "@/i18n";
import { api, errorMessage } from "@/lib/api";

export interface ItemFormValue {
  id?: string;
  title: string;
  subtitle: string | null;
  author: string | null;
  printPlace: string | null;
  printYear: string | null;
  publisher: string | null;
  bibliographicNotes: string | null;
  internalNotes: string | null;
  conditionNotes: string | null;
  heightMm: number | null;
  widthMm: number | null;
  depthMm: number | null;
  sizeCategory: BookSize;
  barcode?: string;
  inventoryNumber?: string;
}

/** New book received into inventory, or edit of its bibliographic / physical details. */
export function ItemFormDialog({
  open,
  onClose,
  initial,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  initial?: ItemFormValue;
  onCreated?: (item: { id: string; inventoryNumber: string; title: string }) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = !!initial?.id;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const str = (k: string) => String(f.get(k) ?? "").trim() || null;
    const mm = (k: string) => (str(k) ? Number(str(k)) : null);
    const barcode = str("barcode");
    const body = {
      title: str("title") ?? "",
      subtitle: str("subtitle"),
      author: str("author"),
      printPlace: str("printPlace"),
      printYear: str("printYear"),
      publisher: str("publisher"),
      bibliographicNotes: str("bibliographicNotes"),
      internalNotes: str("internalNotes"),
      conditionNotes: str("conditionNotes"),
      heightMm: mm("heightMm"),
      widthMm: mm("widthMm"),
      depthMm: mm("depthMm"),
      sizeCategory: (str("sizeCategory") ?? "UNKNOWN") as BookSize,
      ...(barcode && barcode !== initial?.inventoryNumber ? { barcode } : {}),
    };
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await api(`/api/inventory/${initial!.id}`, { method: "PATCH", json: body });
        toast.success("פרטי הספר נשמרו");
        onClose();
        router.refresh();
      } else {
        const r = await api<{ item: { id: string; inventoryNumber: string; title: string } }>("/api/inventory", { method: "POST", json: body });
        toast.success(`נקלט למלאי: ${r.item.inventoryNumber}`, { detail: r.item.title });
        onClose();
        // push alone: a refresh() right after a push re-renders the current page and cancels the navigation
        if (onCreated) {
          onCreated(r.item);
          router.refresh();
        } else router.push(`/inventory/${r.item.id}`);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? `עריכת ${initial?.inventoryNumber ?? "ספר"}` : "ספר חדש למלאי"}
      description={editing ? undefined : "מספר מלאי (ITM-…) יוקצה אוטומטית. מידות אינן חובה — אם ידועות, הן משמשות להצעת מיקום במחסן."}
      width="lg"
    >
      <form id="item-form" onSubmit={submit} className="grid grid-cols-6 gap-x-3 gap-y-4">
        <Field label="שם הספר" required className="col-span-6">
          {(p) => <Input {...p} name="title" required maxLength={300} autoFocus defaultValue={initial?.title} />}
        </Field>
        <Field label="מחבר" className="col-span-3">
          {(p) => <Input {...p} name="author" maxLength={200} defaultValue={initial?.author ?? ""} />}
        </Field>
        <Field label="כותרת משנה" className="col-span-3">
          {(p) => <Input {...p} name="subtitle" maxLength={300} defaultValue={initial?.subtitle ?? ""} />}
        </Field>
        <Field label="מקום דפוס" className="col-span-2">
          {(p) => <Input {...p} name="printPlace" maxLength={200} defaultValue={initial?.printPlace ?? ""} />}
        </Field>
        <Field label="שנת דפוס" className="col-span-2">
          {(p) => <Input {...p} name="printYear" maxLength={50} defaultValue={initial?.printYear ?? ""} />}
        </Field>
        <Field label="מדפיס / הוצאה" className="col-span-2">
          {(p) => <Input {...p} name="publisher" maxLength={200} defaultValue={initial?.publisher ?? ""} />}
        </Field>
        <Field label="פרטים ביבליוגרפיים" className="col-span-6">
          {(p) => <Textarea {...p} name="bibliographicNotes" rows={2} maxLength={5000} defaultValue={initial?.bibliographicNotes ?? ""} />}
        </Field>
        <Field label="גובה (מ״מ)" className="col-span-1">
          {(p) => <Input {...p} name="heightMm" type="number" min={1} max={5000} inputMode="numeric" className="num" defaultValue={initial?.heightMm ?? ""} />}
        </Field>
        <Field label="רוחב (מ״מ)" className="col-span-1">
          {(p) => <Input {...p} name="widthMm" type="number" min={1} max={5000} inputMode="numeric" className="num" defaultValue={initial?.widthMm ?? ""} />}
        </Field>
        <Field label="עובי (מ״מ)" className="col-span-1">
          {(p) => <Input {...p} name="depthMm" type="number" min={1} max={5000} inputMode="numeric" className="num" defaultValue={initial?.depthMm ?? ""} />}
        </Field>
        <Field label="קטגוריית גודל" hint="ריק = לפי המידות" className="col-span-3">
          {(p) => (
            <Select {...p} name="sizeCategory" defaultValue={initial?.sizeCategory ?? "UNKNOWN"}>
              {BOOK_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s === "UNKNOWN" ? "אוטומטי / לא ידוע" : t.bookSize[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="מצב פיזי של העותק" className="col-span-3">
          {(p) => <Textarea {...p} name="conditionNotes" rows={2} maxLength={2000} defaultValue={initial?.conditionNotes ?? ""} />}
        </Field>
        <Field label="הערות פנימיות" className="col-span-3">
          {(p) => <Textarea {...p} name="internalNotes" rows={2} maxLength={5000} defaultValue={initial?.internalNotes ?? ""} />}
        </Field>
        <Field label="ברקוד חיצוני (אופציונלי)" hint="רק אם על המארז כבר מודבק ברקוד אחר. ברירת מחדל: מספר המלאי." className="col-span-6">
          {(p) => <Input {...p} name="barcode" dir="ltr" maxLength={64} className="font-mono" defaultValue={initial?.barcode && initial.barcode !== initial.inventoryNumber ? initial.barcode : ""} />}
        </Field>
        {error && (
          <p className="col-span-6 rounded-md bg-danger-soft px-3 py-2.5 text-[13px] text-danger" role="alert">
            {error}
          </p>
        )}
      </form>
      <div className="mt-5 flex gap-2">
        <Button type="submit" form="item-form" variant="primary" loading={saving}>
          {editing ? "שמירה" : "קליטה למלאי"}
        </Button>
        <Button onClick={onClose}>ביטול</Button>
      </div>
    </Dialog>
  );
}
