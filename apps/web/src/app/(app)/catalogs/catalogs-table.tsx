"use client";

import { useState } from "react";
import Link from "next/link";
import { BookOpen, Trash2, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { CatalogStatusBadge } from "@/components/ui/badge";
import { EmptyState, Progress } from "@/components/ui/misc";
import { DeleteDialog } from "@/components/deletion/delete-dialog";
import { fmt } from "@/i18n";
import { cn } from "@/lib/cn";
import { CatalogActions, type CatalogFormValue } from "./catalogs-client";

export interface CatalogRowDto {
  id: string;
  number: string;
  name: string;
  description: string | null;
  saleDate: string | null;
  status: CatalogFormValue["status"];
  lotCount: number;
  completedCount: number;
  photoCount: number;
  updatedAt: string;
}

/** The catalogs of one auction house with select-all and one-step permanent deletion (books stay in inventory). */
export function CatalogsTable({ rows, canEdit, canDelete, emptyText }: { rows: CatalogRowDto[]; canEdit: boolean; canDelete: boolean; emptyText: string }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const selectable = canDelete;
  const all = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <>
      <div className="card mt-4">
        {rows.length === 0 ? (
          <EmptyState icon={<BookOpen />} title="עדיין אין קטלוגים">
            {emptyText}
          </EmptyState>
        ) : (
          <table className="w-full text-[13.5px]">
            <thead>
              <tr className="border-b border-rule text-start text-[12.5px] text-muted">
                {selectable && (
                  <th className="w-10 ps-4 pe-1 py-3">
                    <input type="checkbox" aria-label="בחירת כל הקטלוגים" checked={all} onChange={() => setSelected(all ? new Set() : new Set(rows.map((r) => r.id)))} className="size-4 accent-[var(--color-ink)]" />
                  </th>
                )}
                <th className="w-20 px-4 py-3 text-start font-medium">מספר</th>
                <th className="px-3 py-3 text-start font-medium">שם הקטלוג</th>
                <th className="w-28 px-3 py-3 text-start font-medium">סטטוס</th>
                <th className="hidden w-52 px-3 py-3 text-start font-medium md:table-cell">התקדמות</th>
                <th className="hidden w-24 px-3 py-3 text-start font-medium lg:table-cell">תמונות</th>
                <th className="hidden w-28 px-3 py-3 text-start font-medium lg:table-cell">מכירה</th>
                <th className="hidden w-28 px-3 py-3 text-start font-medium xl:table-cell">עודכן</th>
                <th className="w-14 px-3 py-3" aria-label="פעולות" />
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {rows.map((c) => (
                <tr key={c.id} className={cn("relative transition-colors hover:bg-stone-2", selected.has(c.id) && "bg-accent-soft/50 hover:bg-accent-soft/70")}>
                  {selectable && (
                    <td className="relative z-10 ps-4 pe-1 py-3">
                      <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} aria-label={`בחירת קטלוג ${c.number}`} className="size-4 accent-[var(--color-ink)]" />
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <span className="num inline-flex h-7 min-w-9 items-center justify-center rounded-md bg-stone px-2 text-[13px] font-semibold">{c.number}</span>
                  </td>
                  <td className="max-w-0 px-3 py-3">
                    <Link href={`/catalogs/${c.id}`} className="block truncate font-semibold text-ink after:absolute after:inset-0">
                      {c.name}
                    </Link>
                    {c.description && <div className="truncate text-[12.5px] text-muted">{c.description}</div>}
                  </td>
                  <td className="px-3 py-3">
                    <CatalogStatusBadge status={c.status} />
                  </td>
                  <td className="hidden px-3 py-3 md:table-cell">
                    <div className="flex items-center gap-3">
                      <Progress value={c.completedCount} max={c.lotCount} className="w-24" />
                      <span className="num text-[12.5px] text-muted">
                        {c.completedCount}/{c.lotCount}
                      </span>
                    </div>
                  </td>
                  <td className="num hidden px-3 py-3 text-start text-ink-2 lg:table-cell">{fmt.num(c.photoCount)}</td>
                  <td className="hidden px-3 py-3 text-muted lg:table-cell">{c.saleDate ? fmt.date(c.saleDate) : "\u2014"}</td>
                  <td className="hidden px-3 py-3 text-muted xl:table-cell" title={fmt.dateTime(c.updatedAt)}>
                    {fmt.relative(c.updatedAt)}
                  </td>
                  <td className="relative z-10 px-3 py-3">
                    {canEdit && (
                      <CatalogActions
                        catalog={{ id: c.id, number: c.number, name: c.name, description: c.description, saleDate: c.saleDate, status: c.status, photoCount: c.photoCount }}
                        canDelete={canDelete}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected.size > 0 && (
        <div className="animate-pop fixed inset-x-0 bottom-6 z-30 mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 rounded-xl bg-ink py-2 pe-2 ps-4 text-[13.5px] text-paper shadow-pop ring-1 ring-white/10">
          <span>
            נבחרו <span className="num font-semibold">{selected.size}</span> קטלוגים
          </span>
          <Button size="sm" className="border-danger/50 bg-danger/20 text-white shadow-none hover:bg-danger/35" icon={<Trash2 />} onClick={() => setDeleteIds([...selected])}>
            מחיקה
          </Button>
          <IconButton label="ניקוי בחירה" size="sm" className="text-white/60 hover:bg-white/10 hover:text-white" onClick={() => setSelected(new Set())}>
            <X />
          </IconButton>
        </div>
      )}
      {deleteIds && <DeleteDialog kind="catalogs" open ids={deleteIds} onClose={() => setDeleteIds(null)} onDone={() => setSelected(new Set())} />}
    </>
  );
}
