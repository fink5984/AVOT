"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PickStatus } from "@avot/shared";
import { Button } from "@/components/ui/button";
import { Badge, type Tone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { fmt, t } from "@/i18n";
import { api, errorMessage } from "@/lib/api";

const TONE: Record<PickStatus, Tone> = { OPEN: "accent", PICKED: "info", PACKED: "info", SHIPPED: "green", CANCELLED: "neutral" };

interface Task {
  id: string;
  status: PickStatus;
  reason: string;
  createdAt: string;
  item: { id: string; inventoryNumber: string; title: string; thumbAssetId: string | null };
  location: { code: string; label: string } | null;
  lot: { lotNumber: number; catalogNumber: string; house: string } | null;
}

export function PickTable({ tasks, showAll, perms }: { tasks: Task[]; showAll: boolean; perms: { fulfil: boolean; manage: boolean } }) {
  const router = useRouter();
  const toast = useToast();
  async function act(id: string, action: "packed" | "shipped" | "cancel") {
    if (action === "cancel" && !window.confirm("לבטל את משימת הליקוט?")) return;
    try {
      await api(`/api/picks/${id}/${action}`, { method: "POST" });
      toast.success(action === "packed" ? "סומן נארז" : action === "shipped" ? "סומן נשלח" : "המשימה בוטלה");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Link href={showAll ? "/warehouse/picking" : "/warehouse/picking?all=1"} className="text-[13px] font-medium text-muted hover:text-ink">
          {showAll ? "פתוחות בלבד" : "כולל משימות שהסתיימו"}
        </Link>
      </div>
      <div className="card overflow-x-auto">
        {tasks.length === 0 ? (
          <EmptyState title="אין משימות ליקוט">משימת ליקוט נוצרת אוטומטית כשספר מסומן כנמכר.</EmptyState>
        ) : (
          <table className="w-full min-w-[900px] text-[13.5px]">
            <thead>
              <tr className="border-b border-rule text-[12.5px] text-muted">
                <th className="w-8 px-4 py-3 text-start font-medium">#</th>
                <th className="w-36 px-3 py-3 text-start font-medium">מיקום</th>
                <th className="px-3 py-3 text-start font-medium">ספר</th>
                <th className="w-48 px-3 py-3 text-start font-medium">סיבה</th>
                <th className="w-28 px-3 py-3 text-start font-medium">מצב</th>
                <th className="w-56 px-3 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {tasks.map((p, i) => (
                <tr key={p.id}>
                  <td className="num px-4 py-2.5 text-muted">{i + 1}</td>
                  <td className="px-3 py-2.5">
                    <span className="num font-mono font-semibold">{p.location?.code ?? "—"}</span>
                  </td>
                  <td className="max-w-0 px-3 py-2.5">
                    <Link href={`/inventory/${p.item.id}`} className="block truncate font-medium hover:underline">
                      <span className="num font-mono text-[12.5px] text-muted">{p.item.inventoryNumber}</span> {p.item.title}
                    </Link>
                    {p.lot && (
                      <div className="text-[12px] text-muted">
                        {p.lot.house} · קטלוג {p.lot.catalogNumber} · פריט {p.lot.lotNumber}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-[12.5px] text-muted">
                    {p.reason}
                    <div className="text-[11.5px] text-faint" suppressHydrationWarning>{fmt.dateTime(p.createdAt)}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge tone={TONE[p.status]}>{t.pickStatus[p.status]}</Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex justify-end gap-1.5">
                      {perms.fulfil && p.status === "PICKED" && (
                        <Button size="sm" onClick={() => act(p.id, "packed")}>
                          נארז
                        </Button>
                      )}
                      {perms.fulfil && p.status === "PACKED" && (
                        <Button size="sm" variant="accent" onClick={() => act(p.id, "shipped")}>
                          נשלח
                        </Button>
                      )}
                      {perms.manage && ["OPEN", "PICKED", "PACKED"].includes(p.status) && (
                        <Button size="sm" variant="ghost" onClick={() => act(p.id, "cancel")}>
                          ביטול
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
