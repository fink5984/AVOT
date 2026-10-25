"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge, type Tone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { fmt, t } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";

interface Ev {
  id: string;
  mode: keyof typeof t.scanMode;
  code: string;
  result: "OK" | "NOOP" | "ERROR" | "CONFLICT";
  message: string | null;
  clientAt: string;
  receivedAt: string;
  deferred: boolean;
  userName: string | null;
  item: { id: string; inventoryNumber: string; title: string; currentLocation: { code: string } | null } | null;
  location: string | null;
  contextLocation: string | null;
  resolvedAt: string | null;
  resolution: string | null;
}

const TONE: Record<Ev["result"], Tone> = { OK: "green", NOOP: "neutral", ERROR: "danger", CONFLICT: "warn" };
const LABEL: Record<Ev["result"], string> = { OK: "בוצע", NOOP: "ללא שינוי", ERROR: "נכשל", CONFLICT: "דורש טיפול" };
const FILTERS = [
  { key: "all", label: "הכול", href: "/scans" },
  { key: "open", label: "ממתינות להחלטה", href: "/scans?open=1" },
  { key: "ERROR", label: "שגיאות", href: "/scans?result=ERROR" },
  { key: "CONFLICT", label: "סתירות", href: "/scans?result=CONFLICT" },
];

export function ScanLog({ events, filter, canResolve }: { events: Ev[]; filter: string; canResolve: boolean }) {
  const router = useRouter();
  const toast = useToast();
  async function resolve(id: string, action: "apply" | "dismiss") {
    try {
      await api(`/api/scan/events/${id}/resolve`, { method: "POST", json: { action } });
      toast.success(action === "apply" ? "הפעולה בוצעה" : "הפעולה נדחתה");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  return (
    <>
      <nav className="mb-3 inline-flex gap-0.5 rounded-lg bg-stone p-0.5" aria-label="סינון">
        {FILTERS.map((f) => (
          <Link key={f.key} href={f.href} aria-current={filter === f.key ? "page" : undefined} className={cn("rounded-md px-3 py-1.5 text-[13px] font-medium", filter === f.key ? "bg-paper shadow-card ring-1 ring-rule" : "text-ink-2")}>
            {f.label}
          </Link>
        ))}
      </nav>
      <div className="card overflow-x-auto">
        {events.length === 0 ? (
          <EmptyState title="אין סריקות להצגה" />
        ) : (
          <table className="w-full min-w-[1000px] text-[13px]">
            <thead>
              <tr className="border-b border-rule text-[12.5px] text-muted">
                <th className="w-36 px-4 py-2.5 text-start font-medium">זמן סריקה</th>
                <th className="w-20 px-3 py-2.5 text-start font-medium">מצב</th>
                <th className="w-40 px-3 py-2.5 text-start font-medium">קוד</th>
                <th className="px-3 py-2.5 text-start font-medium">תוצאה</th>
                <th className="w-28 px-3 py-2.5 text-start font-medium">משתמש</th>
                <th className="w-48 px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {events.map((e) => (
                <tr key={e.id} className={cn(e.result === "CONFLICT" && !e.resolvedAt && "bg-warn-soft/50")}>
                  <td className="px-4 py-2" suppressHydrationWarning>
                    {fmt.dateTime(e.clientAt)}
                    {e.deferred && <div className="text-[11.5px] text-warn" suppressHydrationWarning>סונכרן {fmt.dateTime(e.receivedAt)}</div>}
                  </td>
                  <td className="px-3 py-2">{t.scanMode[e.mode]}</td>
                  <td className="px-3 py-2">
                    <span className="num font-mono">{e.code}</span>
                    {e.contextLocation && <div className="num font-mono text-[11.5px] text-muted">→ {e.contextLocation}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Badge tone={TONE[e.result]}>{LABEL[e.result]}</Badge>
                      <span className="min-w-0 truncate">{e.message}</span>
                    </div>
                    {e.item && (
                      <Link href={`/inventory/${e.item.id}`} className="text-[12px] text-muted hover:underline">
                        {e.item.inventoryNumber} · {e.item.title} · כעת: {e.item.currentLocation?.code ?? "ללא מיקום"}
                      </Link>
                    )}
                    {e.resolvedAt && <div className="text-[11.5px] text-muted" suppressHydrationWarning>הוחלט: {e.resolution === "APPLIED" ? "בוצע" : "נדחה"} · {fmt.dateTime(e.resolvedAt)}</div>}
                  </td>
                  <td className="px-3 py-2 text-muted">{e.userName ?? "—"}</td>
                  <td className="px-3 py-2">
                    {canResolve && e.result === "CONFLICT" && !e.resolvedAt && (
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" onClick={() => resolve(e.id, "apply")} title={`להעביר ל-${e.location ?? e.contextLocation}`}>
                          ביצוע ההעברה
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => resolve(e.id, "dismiss")}>
                          דחייה
                        </Button>
                      </div>
                    )}
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
