"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PackageCheck } from "lucide-react";
import { Panel, Progress } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";

interface Fulfilment {
  total: number;
  picked: number;
  packed: number;
  shipped: number;
  readyToShip: boolean;
  allShipped: boolean;
  label: string;
  books: { taskId: string; status: string; itemId: string; inventoryNumber: string; title: string }[];
}

const STATUS: Record<string, string> = { OPEN: "ממתין לליקוט", PICKED: "לוקט", PACKED: "נארז", SHIPPED: "נשלח" };

/** A sold combined lot: one pick task per book, "נאספו 2 מתוך 3 ספרים". The lot is ready only when every book is handled. */
export function FulfilmentCard({ lotId }: { lotId: string }) {
  const [f, setF] = useState<Fulfilment | null>(null);
  useEffect(() => {
    void api<Fulfilment>(`/api/lots/${lotId}/fulfilment`).then(setF).catch(() => undefined);
  }, [lotId]);
  if (!f || f.total === 0) return null;
  return (
    <Panel title={<span className="flex items-center gap-2"><PackageCheck className="size-4 text-accent" aria-hidden />ליקוט ומשלוח</span>}>
      <div className="space-y-3 p-4 text-[13.5px]">
        <div className="flex items-center gap-3">
          <Progress value={f.picked} max={f.total} className="h-2" />
          <span className="shrink-0 font-medium" role="status">{f.label}</span>
        </div>
        <p className={cn("text-[12.5px]", f.readyToShip ? "text-green" : "text-muted")}>
          {f.allShipped ? "כל ספרי הלוט נשלחו." : f.readyToShip ? "כל הספרים נארזו - הלוט מוכן למשלוח." : "הלוט מוכן למשלוח רק לאחר שכל הספרים נאספו ונארזו. כל ספר נסרק בנפרד."}
        </p>
        <ul className="divide-y divide-rule rounded-lg border border-rule">
          {f.books.map((b) => (
            <li key={b.taskId} className="flex items-center gap-3 px-3 py-2 text-[13px]">
              <Link href={`/inventory/${b.itemId}`} className="num font-mono text-[11.5px] hover:underline">{b.inventoryNumber}</Link>
              <span className="min-w-0 flex-1 truncate">{b.title}</span>
              <span className="text-[12px] text-muted">{STATUS[b.status] ?? b.status}</span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}
