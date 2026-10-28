"use client";

import { useCallback } from "react";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, errorMessage } from "@/lib/api";

export type PrintRef = { type: "BOOK" | "LOCATION" | "ZONE"; id: string };
export interface PrintOptions {
  copies?: number;
  zoneId?: string;
  warehouseId?: string;
  /** shown in the confirmation ("תווית 10000184") */
  what?: string;
}

/**
 * One click → one label (or batch) on the shop's fixed printer. The request carries a fresh key, so a
 * double click or a retry after a lost response never queues the same labels twice. No browser print
 * dialog, no PDF.
 */
export function usePrintLabels() {
  const toast = useToast();
  return useCallback(
    async (items: PrintRef[], opts: PrintOptions = {}) => {
      try {
        const r = await api<{ jobs: { id: string; labelCount: number }[] }>("/api/print/jobs", {
          method: "POST",
          json: { items, copies: opts.copies ?? 1, zoneId: opts.zoneId, warehouseId: opts.warehouseId, idemKey: crypto.randomUUID() },
        });
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
