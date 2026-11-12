"use client";

import { useEffect, useState } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/field";

/** what the server says about a print it wants confirmed (see PrintConfirmation in services/printing.ts) */
export interface PrintConfirmDetails {
  level: "confirm" | "typed";
  labels: number;
  items: number;
  copies: number;
  printerName: string;
  kindLabel: string;
}
export type PrintConfirmResult = { confirmed: true; confirmCount?: number } | null;

type Pending = { details: PrintConfirmDetails; resolve: (r: PrintConfirmResult) => void };
let listener: ((p: Pending) => void) | null = null;

/** Opens the one shared confirmation window. Resolves null when the person cancels. */
export function askPrintConfirmation(details: PrintConfirmDetails): Promise<PrintConfirmResult> {
  return new Promise((resolve) => {
    if (!listener) return resolve(null);
    listener({ details, resolve });
  });
}

/** Mounted once in the root layout: every print in the app asks here, nobody builds a window of their own. */
export function PrintConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [typed, setTyped] = useState("");
  useEffect(() => {
    listener = (p) => {
      setTyped("");
      setPending(p);
    };
    return () => {
      listener = null;
    };
  }, []);
  const d = pending?.details;
  const finish = (r: PrintConfirmResult) => {
    pending?.resolve(r);
    setPending(null);
  };
  const okTyped = d?.level !== "typed" || typed.trim() === String(d.labels);
  return (
    <Dialog
      open={!!pending}
      onClose={() => finish(null)}
      title={d?.level === "typed" ? "אישור הדפסה גדולה" : "אישור הדפסה"}
      footer={
        <>
          <Button variant="ghost" onClick={() => finish(null)}>
            ביטול
          </Button>
          <Button variant="primary" icon={<Printer />} disabled={!okTyped} onClick={() => finish({ confirmed: true, ...(d?.level === "typed" ? { confirmCount: d.labels } : {}) })}>
            {d ? `הדפסת ${d.labels} מדבקות` : "הדפסה"}
          </Button>
        </>
      }
    >
      {d && (
        <div className="space-y-3 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-ink-2">סוג</dt>
            <dd>{d.kindLabel}</dd>
            <dt className="text-ink-2">פריטים</dt>
            <dd>{d.items}</dd>
            <dt className="text-ink-2">עותקים לכל פריט</dt>
            <dd>{d.copies}</dd>
            <dt className="text-ink-2">סה״כ מדבקות</dt>
            <dd className="font-semibold">{d.labels}</dd>
            <dt className="text-ink-2">מדפסת</dt>
            <dd>{d.printerName}</dd>
          </dl>
          {d.level === "typed" && (
            <label className="block">
              <span className="mb-1 block font-medium">אתה עומד להדפיס {d.labels} מדבקות. הקלד {d.labels} כדי לאשר.</span>
              <Input
                inputMode="numeric"
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && okTyped) finish({ confirmed: true, confirmCount: d.labels });
                }}
                aria-label="כמות המדבקות לאישור"
              />
            </label>
          )}
        </div>
      )}
    </Dialog>
  );
}
