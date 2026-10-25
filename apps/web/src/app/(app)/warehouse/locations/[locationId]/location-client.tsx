"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BOOK_SIZES, type BookSize } from "@avot/shared";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { t } from "@/i18n";
import { api, errorMessage } from "@/lib/api";

export function LocationEditor({ location }: { location: { id: string; sizeClass: BookSize | null; capacity: number | null; isFull: boolean; notes: string | null; active: boolean } }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      await api(`/api/warehouse/locations/${location.id}`, {
        method: "PATCH",
        json: {
          sizeClass: (f.get("sizeClass") as string) || null,
          capacity: f.get("capacity") ? Number(f.get("capacity")) : null,
          isFull: f.get("isFull") === "on",
          active: f.get("active") === "on",
          notes: (f.get("notes") as string) || null,
        },
      });
      toast.success("המיקום עודכן");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-4 px-5 py-4">
      <Field label="גודל ספרים מתאים">
        {(p) => (
          <Select {...p} name="sizeClass" defaultValue={location.sizeClass ?? ""}>
            <option value="">כל הגדלים</option>
            {BOOK_SIZES.filter((s) => s !== "UNKNOWN").map((s) => (
              <option key={s} value={s}>
                {t.bookSize[s]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="קיבולת מומלצת (ספרים)">
        {(p) => <Input {...p} name="capacity" type="number" min={1} max={10000} defaultValue={location.capacity ?? ""} className="num" />}
      </Field>
      <Checkbox name="isFull" label="המיקום מלא (לא יוצע לאחסון)" defaultChecked={location.isFull} />
      <Checkbox name="active" label="מיקום פעיל" defaultChecked={location.active} />
      <Field label="הערות">
        {(p) => <Textarea {...p} name="notes" rows={2} maxLength={1000} defaultValue={location.notes ?? ""} />}
      </Field>
      <Button type="submit" variant="primary" loading={busy}>
        שמירה
      </Button>
    </form>
  );
}
