"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { errorMessage } from "@/lib/api";
import { ConsignorSelect } from "./consignor-select";
import type { ConsignorLite } from "./consignor-dialog";

/**
 * Asks only for a consignor. Used where a book is created from another one (an additional physical copy): the
 * consignor is never copied — the second copy may belong to somebody else — so nothing is preselected.
 */
export function ConsignorPickDialog({
  open,
  onClose,
  heading,
  description,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  heading: string;
  description?: React.ReactNode;
  confirmLabel: string;
  onConfirm: (consignor: ConsignorLite) => Promise<void> | void;
}) {
  const [consignor, setConsignor] = useState<ConsignorLite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setConsignor(null);
    setBusy(false);
    setError(null);
  }, [open]);

  async function submit() {
    if (busy) return;
    if (!consignor) {
      setError("יש לבחור מפקיד");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(consignor);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={() => !busy && onClose()} title={heading} description={description} width="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void submit();
        }}
        className="space-y-3.5"
      >
        <Field label="מפקיד" required>
          {(p) => <ConsignorSelect id={p.id} value={consignor} onChange={(c) => (setConsignor(c), setError(null))} autoFocus invalid={!!error && !consignor} onCommit={() => void submit()} />}
        </Field>
        {error && (
          <p className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2 pt-1">
          <Button type="submit" variant="primary" loading={busy}>
            {confirmLabel}
          </Button>
          <Button onClick={onClose} disabled={busy}>
            ביטול
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
