"use client";

import Link from "next/link";
import { ArrowRight, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PrintBar({ catalogId, count, from, to, single }: { catalogId: string; count: number; from?: string; to?: string; single: boolean }) {
  return (
    <div className="no-print flex flex-wrap items-center gap-3 border-b border-rule px-4 py-4 lg:px-8">
      <Link href={`/catalogs/${catalogId}`} className="flex items-center gap-1 text-[13.5px] font-medium text-muted hover:text-ink">
        <ArrowRight className="size-4" /> חזרה לקטלוג
      </Link>
      <span className="text-[13.5px] text-muted">
        <span className="num font-medium text-ink">{count}</span> תוויות · גיליון A4, 3×8 (70×37 מ״מ)
      </span>
      {!single && (
        <form className="flex items-center gap-1.5 text-[13px]">
          <label>
            מפריט <input name="from" defaultValue={from} type="number" min={1} className="num h-9 w-20 rounded-md border border-rule-strong bg-paper px-2 text-start" />
          </label>
          <label>
            עד <input name="to" defaultValue={to} type="number" min={1} className="num h-9 w-20 rounded-md border border-rule-strong bg-paper px-2 text-start" />
          </label>
          <button className="h-9 rounded-md border border-rule-strong bg-paper px-3 font-medium hover:bg-stone-2">סינון</button>
        </form>
      )}
      <Button variant="primary" className="ms-auto" icon={<Printer />} onClick={() => window.print()}>
        הדפסה
      </Button>
    </div>
  );
}
