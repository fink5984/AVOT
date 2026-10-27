"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ApiError, api, errorMessage } from "@/lib/api";

export type NewBookTarget = { kind: "inventory" } | { kind: "catalog"; catalogId: string; catalogLabel: string };

/**
 * "+ ספר חדש" inside the capture screen: one field, Enter creates the book and the studio moves to it —
 * the camera connection is never touched. Started from a catalog, the new book is received into inventory
 * AND assigned to that catalog (said in the dialog). The last shot of the current book must be durably
 * stored before the studio moves on; `waitDurable` guarantees that and the dialog says when it is waiting.
 */
export function NewBookDialog({
  open,
  onClose,
  target,
  finishing,
  waitDurable,
  onFinish,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  target: NewBookTarget;
  /** "סיים ספר וצור חדש": the current book is marked complete first */
  finishing?: { label: string; statusLabel: string } | null;
  waitDurable: () => Promise<boolean>;
  onFinish?: () => Promise<void>;
  onCreated: (targetId: string) => void | Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState<"idle" | "saving" | "creating">("idle");
  const [error, setError] = useState<string | null>(null);
  const opId = useRef(crypto.randomUUID());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setError(null);
    setBusy("idle");
    opId.current = crypto.randomUUID();
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const name = title.trim();
    if (!name || busy !== "idle") return;
    setError(null);
    setBusy("saving");
    try {
      if (!(await waitDurable())) {
        setError("הצילום האחרון עדיין לא נשמר באופן בטוח. המתינו רגע ונסו שוב — לא עוברים לספר הבא לפני כן.");
        setBusy("idle");
        return;
      }
      if (onFinish) await onFinish();
      setBusy("creating");
      // the same key on every attempt of this dialog: a retry after a lost response cannot create a second book
      const r =
        target.kind === "catalog"
          ? await api<{ lot: { id: string } }>(`/api/catalogs/${target.catalogId}/lots`, { method: "POST", json: { title: name, opId: opId.current } })
          : await api<{ item: { id: string } }>("/api/inventory", { method: "POST", json: { title: name, opId: opId.current } });
      const id = "lot" in r ? r.lot.id : r.item.id;
      opId.current = crypto.randomUUID();
      await onCreated(id);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 0 ? "אין חיבור לשרת — הספר לא נוצר. נסו שוב כשהחיבור חוזר." : errorMessage(err));
      setBusy("idle");
    }
  }

  return (
    <Dialog open={open} onClose={() => busy === "idle" && onClose()} title={finishing ? "סיום ספר וספר חדש" : "ספר חדש"} width="sm">
      <form onSubmit={submit} className="space-y-3">
        {finishing && (
          <p className="rounded-md bg-stone px-3 py-2 text-[13px] text-ink-2">
            {finishing.label} יסומן <b>{finishing.statusLabel}</b> ואז יעבור הצילום לספר החדש.
          </p>
        )}
        <label htmlFor="new-book-title" className="text-[13px] font-medium text-ink-2">
          שם הספר
        </label>
        <input
          id="new-book-title"
          ref={input}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={300}
          autoComplete="off"
          placeholder="הקלידו שם ולחצו Enter"
          className="h-11 w-full rounded-md border border-rule-strong bg-paper px-3 text-[15px] shadow-card focus:border-ink/50 focus:outline-none focus:ring-[3px] focus:ring-ink/8"
        />
        <p className="text-[12.5px] text-muted">
          {target.kind === "catalog" ? (
            <>
              הספר ייווצר במלאי <b>וישויך אוטומטית לקטלוג {target.catalogLabel}</b>.
            </>
          ) : (
            <>הספר ייווצר במלאי בלבד (ללא שיוך לקטלוג).</>
          )}{" "}
          הצילום עובר אליו מיד, בקטגוריה ״כריכה״, והמצלמה נשארת מחוברת.
        </p>
        {busy === "saving" && (
          <p className="flex items-center gap-2 text-[12.5px] text-muted" role="status">
            <Loader2 className="size-3.5 animate-spin" /> ממתין לשמירת הצילום האחרון…
          </p>
        )}
        {error && (
          <p className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2 pt-1">
          <Button type="submit" variant="primary" loading={busy !== "idle"} disabled={!title.trim()}>
            {finishing ? "סיום ויצירת ספר" : "יצירה ומעבר"}
          </Button>
          <Button onClick={onClose} disabled={busy !== "idle"}>
            ביטול
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
