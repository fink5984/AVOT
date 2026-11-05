"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { api, errorMessage } from "@/lib/api";
import type { ConsignorDto } from "@/server/services/consignors";

export type ConsignorLite = Pick<ConsignorDto, "id" | "name">;

/**
 * Create or edit a consignor. Small on purpose: the name is the only required field. It is rendered in a portal and
 * stops its own submit from reaching the form it was opened from (the "ספר חדש" forms), so saving a consignor
 * never submits, resets or closes the book form underneath.
 */
export function ConsignorDialog({
  open,
  onClose,
  initial,
  defaultName,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  initial?: ConsignorDto;
  /** text the user already typed in the picker */
  defaultName?: string;
  onSaved: (c: ConsignorDto) => void;
}) {
  const editing = !!initial;
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // one key per opening: a double click or a retry after a lost response returns the same consignor
  const opId = useRef(crypto.randomUUID());
  useEffect(() => {
    if (open) {
      opId.current = crypto.randomUUID();
      setError(null);
      setSaving(false);
    }
  }, [open]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (saving) return;
    const f = new FormData(e.currentTarget);
    const str = (k: string) => String(f.get(k) ?? "").trim();
    const body = { name: str("name"), phone: str("phone") || null, email: str("email") || null, notes: str("notes") || null };
    if (!body.name) {
      setError("שם המפקיד נדרש");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = editing
        ? await api<{ consignor: ConsignorDto }>(`/api/consignors/${initial!.id}`, { method: "PATCH", json: body })
        : await api<{ consignor: ConsignorDto }>("/api/consignors", { method: "POST", json: { ...body, opId: opId.current } });
      onSaved(r.consignor);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (typeof document === "undefined") return null;
  return createPortal(
    <Dialog open={open} onClose={() => !saving && onClose()} title={editing ? "עריכת מפקיד" : "מפקיד חדש"} width="sm">
      <form onSubmit={submit} className="space-y-3.5">
        <Field label="שם המפקיד" required>
          {(p) => <Input {...p} name="name" required maxLength={200} autoFocus autoComplete="off" defaultValue={initial?.name ?? defaultName ?? ""} />}
        </Field>
        <Field label="טלפון">
          {(p) => <Input {...p} name="phone" type="tel" dir="ltr" maxLength={40} autoComplete="off" className="text-start" defaultValue={initial?.phone ?? ""} />}
        </Field>
        <Field label="דוא״ל">
          {(p) => <Input {...p} name="email" type="email" dir="ltr" maxLength={200} autoComplete="off" className="text-start" defaultValue={initial?.email ?? ""} />}
        </Field>
        <Field label="הערות">
          {(p) => <Textarea {...p} name="notes" rows={2} maxLength={5000} defaultValue={initial?.notes ?? ""} />}
        </Field>
        {error && (
          <p className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2 pt-1">
          <Button type="submit" variant="primary" loading={saving}>
            {editing ? "שמירה" : "שמירת מפקיד"}
          </Button>
          <Button onClick={onClose} disabled={saving}>
            ביטול
          </Button>
        </div>
      </form>
    </Dialog>,
    document.body,
  );
}
