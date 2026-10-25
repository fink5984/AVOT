"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArchiveRestore } from "lucide-react";
import type { PhotoCategory } from "@avot/shared";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { fmt, t } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";

interface TrashItem {
  id: string;
  thumbUrl: string | null;
  rotation: number;
  category: PhotoCategory;
  sequence: number;
  deletedAt: string;
  deletedBy: string | null;
  /** the book the photo belongs to */
  book: { id: string; inventoryNumber: string; title: string };
}

export function TrashList({ items, retentionDays }: { items: TrashItem[]; retentionDays: number }) {
  const router = useRouter();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  async function restore(ids: string[]) {
    setBusy(true);
    try {
      await api("/api/assets/restore", { method: "POST", json: { assetIds: ids } });
      toast.success(`${ids.length} תמונות שוחזרו לספר ולקטגוריה המקוריים`);
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        <Button variant={selected.size ? "primary" : "secondary"} disabled={!selected.size} loading={busy} icon={<ArchiveRestore />} onClick={() => restore([...selected])}>
          שחזור {selected.size ? `${selected.size} נבחרות` : ""}
        </Button>
        <button className="rounded-md px-3 py-2 text-[13px] font-medium text-muted hover:bg-stone hover:text-ink" onClick={() => setSelected(selected.size === items.length ? new Set() : new Set(items.map((i) => i.id)))}>
          {selected.size === items.length ? "ניקוי בחירה" : "בחירת הכול"}
        </button>
      </div>
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
        {items.map((it) => {
          const purgeAt = new Date(new Date(it.deletedAt).getTime() + retentionDays * 86400_000);
          const on = selected.has(it.id);
          return (
            <li key={it.id} className={cn("card overflow-hidden transition-shadow", on && "ring-2 ring-ink")}>
              <button
                className="relative block aspect-[4/3] w-full bg-stone"
                onClick={() =>
                  setSelected((s) => {
                    const n = new Set(s);
                    if (n.has(it.id)) n.delete(it.id);
                    else n.add(it.id);
                    return n;
                  })
                }
                aria-pressed={on}
                aria-label={`בחירת צילום ${it.sequence} מספר ${it.book.inventoryNumber}`}
              >
                {it.thumbUrl && <img src={it.thumbUrl} alt="" loading="lazy" className="size-full object-contain opacity-80" style={{ transform: it.rotation ? `rotate(${it.rotation}deg)` : undefined }} />}
              </button>
              <div className="space-y-0.5 px-3 py-2.5 text-[12.5px]">
                <Link href={`/inventory/${it.book.id}`} className="block truncate font-medium text-ink hover:underline">
                  <span className="num font-mono text-[12.5px]">{it.book.inventoryNumber}</span> · {it.book.title}
                </Link>
                <div className="text-muted">
                  {t.category[it.category]} · צילום <span className="num">{it.sequence}</span>
                </div>
                <div className="text-faint">
                  נמחק {fmt.relative(it.deletedAt)}
                  {it.deletedBy ? ` · ${it.deletedBy}` : ""}
                </div>
                <div className="text-faint">יימחק לצמיתות {fmt.date(purgeAt)}</div>
                <button className="mt-1.5 text-[12.5px] font-semibold text-ink hover:underline" onClick={() => restore([it.id])} disabled={busy}>
                  שחזור
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
