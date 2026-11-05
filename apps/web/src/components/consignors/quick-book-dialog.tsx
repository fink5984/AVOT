"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { errorMessage } from "@/lib/api";
import { ConsignorSelect } from "./consignor-select";
import type { ConsignorLite } from "./consignor-dialog";

interface Props {
  open: boolean;
  onClose: () => void;
  initialTitle: string;
  onConfirm: (v: { title: string; consignor: ConsignorLite; opId: string }) => Promise<void> | void;
  hint?: React.ReactNode;
  heading?: string;
  confirmLabel?: string;
}

/**
 * The small window of every "type a name and press Enter" intake (inventory, catalog): the typed name plus a
 * mandatory consignor. Nothing is preselected: the consignor is always chosen explicitly. `onConfirm` may be async and throw — the
 * message is shown here and the same `opId` is reused by the retry, so a book is never created twice.
 */
export function QuickBookDialog(props: Props) {
  const { open, onClose, heading = "ספר חדש" } = props;
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={() => !busy && onClose()} title={heading} width="sm">
      {/* mounted only while open: every opening starts with fresh state, the last consignor and a new retry key */}
      {open && <QuickBookForm {...props} onBusy={setBusy} />}
    </Dialog>
  );
}

function QuickBookForm({ onClose, initialTitle, onConfirm, hint, confirmLabel = "הוספה", onBusy }: Props & { onBusy: (b: boolean) => void }) {
  const [title, setTitle] = useState(initialTitle);
  const [consignor, setConsignor] = useState<ConsignorLite | null>(null);
  const [busy, setBusyState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const opId = useRef(crypto.randomUUID());
  const titleInput = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const setBusy = (b: boolean) => {
    setBusyState(b);
    onBusy(b);
  };

  async function submit() {
    if (busy) return;
    const name = title.trim();
    if (!name) {
      setError("שם הספר נדרש");
      titleInput.current?.focus();
      return;
    }
    if (!consignor) {
      setMissing(true);
      setError("יש לבחור מפקיד");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm({ title: name, consignor, opId: opId.current });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void submit();
      }}
      className="space-y-3.5"
    >
      <Field label="שם הספר" required>
        {(p) => (
          <Input
            {...p}
            ref={titleInput}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={300}
            autoComplete="off"
            onKeyDown={(e) => {
              // Enter in the name moves on to the consignor when none is chosen yet, otherwise it confirms
              if (e.key === "Enter" && !e.nativeEvent.isComposing && !consignor) {
                e.preventDefault();
                form.current?.querySelector<HTMLInputElement>('[role="combobox"]')?.focus();
              }
            }}
          />
        )}
      </Field>
      <Field label="מפקיד" required error={missing && !consignor ? "יש לבחור מפקיד" : null}>
        {(p) => (
          <ConsignorSelect
            id={p.id}
            value={consignor}
            onChange={(c) => {
              setConsignor(c);
              setMissing(false);
              setError(null);
            }}
            invalid={missing && !consignor}
            autoFocus={!!initialTitle}
            onCommit={() => void submit()}
          />
        )}
      </Field>
      {hint && <p className="text-[12.5px] text-muted">{hint}</p>}
      {error && !missing && (
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
  );
}
