"use client";

import { useCallback } from "react";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, errorMessage } from "@/lib/api";
import { askPrintConfirmation, type PrintConfirmDetails } from "@/components/print/print-confirm";

export type PrintRef = { type: "BOOK" | "LOCATION" | "ZONE"; id: string };
export interface PrintOptions {
  copies?: number;
  zoneId?: string;
  warehouseId?: string;
  /** shown in the confirmation ("תווית 10000184") */
  what?: string;
}

/**
 * Runs a print request; when the server wants a confirmation (6+ labels, typed number for 50+), asks once in the shared
 * window and sends the SAME request again with the answer. Small prints never touch the window.
 */
export async function withPrintConfirmation<T>(send: (confirm: { confirmed?: true; confirmCount?: number }) => Promise<T>): Promise<T | null> {
  try {
    return await send({});
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== "CONFIRMATION_REQUIRED" || !err.details) throw err;
    const answer = await askPrintConfirmation(err.details as PrintConfirmDetails);
    if (!answer) return null;
    return send(answer);
  }
}

/**
 * One click → one label (or batch) on the shop's fixed printer. The request carries a fresh key, so a
 * double click or a retry after a lost response never queues the same labels twice — yet a NEW click is a new request
 * and always prints (no lock on the button). No browser print dialog, no PDF.
 */
export function usePrintLabels() {
  const toast = useToast();
  return useCallback(
    async (items: PrintRef[], opts: PrintOptions = {}) => {
      const idemKey = crypto.randomUUID();
      try {
        const r = await withPrintConfirmation((confirm) =>
          api<{ jobs: { id: string; labelCount: number }[] }>("/api/print/jobs", {
            method: "POST",
            json: { items, copies: opts.copies ?? 1, zoneId: opts.zoneId, warehouseId: opts.warehouseId, idemKey, ...confirm },
          }),
        );
        if (!r) return false; // cancelled in the confirmation window
        const n = r.jobs.reduce((a, j) => a + j.labelCount, 0);
        toast.success(n === 1 ? `${opts.what ?? "התווית"} נשלחה להדפסה` : `${n} תוויות נשלחו להדפסה`, { detail: "ההדפסה תתבצע במדפסת הקבועה" });
        return true;
      } catch (err) {
        const noPrinter = err instanceof ApiError && /מדפסת/.test(err.message);
        toast.error(errorMessage(err), noPrinter ? { detail: "הגדרות ← מדפסת תוויות" } : undefined);
        return false;
      }
    },
    [toast],
  );
}
