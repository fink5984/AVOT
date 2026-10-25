"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookPlus, Camera, FileUp, Gavel, Library, MoreHorizontal, Printer, Tag, X } from "lucide-react";
import type { CommercialStatus, LotStatus, PhysicalStatus } from "@avot/shared";
import { Button, ButtonLink, IconButton } from "@/components/ui/button";
import { CommercialStatusBadge, PhotoStatusBadge, PhysicalStatusBadge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Menu } from "@/components/ui/menu";
import { EmptyState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { HouseMark } from "@/components/house-mark";
import { AssignDialog } from "@/components/inventory/assign-dialog";
import { ItemFormDialog } from "@/components/inventory/item-form-dialog";
import { fmt } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";

export interface InventoryRowDto {
  id: string;
  inventoryNumber: string;
  barcode: string;
  title: string;
  author: string | null;
  photoStatus: LotStatus;
  physicalStatus: PhysicalStatus;
  commercialStatus: CommercialStatus;
  photoCount: number;
  thumbAssetId: string | null;
  location: { id: string; code: string; label: string } | null;
  assignment:
    | { lotId: string; lotNumber: number; commercialStatus: CommercialStatus; catalog: { id: string; number: string; name: string }; house: { slug: string; name: string; accentColor: string } }
    | { hidden: true }
    | null;
  updatedAt: string;
}

export function InventoryActions({ canCreate, canImport, autoOpen }: { canCreate: boolean; canImport: boolean; autoOpen?: boolean }) {
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);
  return (
    <>
      {canImport && (
        <Button icon={<FileUp />} onClick={() => setImportOpen(true)}>
          ייבוא CSV
        </Button>
      )}
      {canCreate && (
        <Button variant="primary" icon={<BookPlus />} onClick={() => setOpen(true)}>
          ספר חדש
        </Button>
      )}
      <ItemFormDialog open={open} onClose={() => setOpen(false)} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}

export function InventoryTable({
  rows,
  total,
  perms,
  defaultHouse,
}: {
  rows: InventoryRowDto[];
  total: number;
  perms: { capture: boolean; assign: boolean; label: boolean; edit: boolean };
  defaultHouse: string | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignFor, setAssignFor] = useState<InventoryRowDto[] | null>(null);
  const all = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const chosen = rows.filter((r) => selected.has(r.id));
  const printLabels = (ids: string[]) => router.push(`/labels/books?ids=${ids.join(",")}`);

  return (
    <>
      <div className="card mt-4 overflow-x-auto">
        {rows.length === 0 ? (
          <EmptyState icon={<Library />} title={total === 0 ? "אין ספרים בתצוגה זו" : "אין תוצאות"}>
            ספר חדש נקלט למלאי עם מספר קבוע (ITM-…). אחר כך מצלמים, מדפיסים תווית, מאחסנים במחסן ומשייכים לקטלוג.
          </EmptyState>
        ) : (
          <table className="w-full min-w-[1180px] text-[13.5px]">
            <thead>
              <tr className="border-b border-rule text-[12.5px] text-muted">
                <th className="w-11 ps-5 pe-1 py-3">
                  <input type="checkbox" aria-label="בחירת הכול" checked={all} onChange={() => setSelected(all ? new Set() : new Set(rows.map((r) => r.id)))} className="size-4 accent-[var(--color-ink)]" />
                </th>
                <th className="w-14 px-2 py-3" aria-label="תמונה" />
                <th className="w-32 px-2 py-3 text-start font-medium">מספר מלאי</th>
                <th className="px-3 py-3 text-start font-medium">שם הספר</th>
                <th className="w-32 px-3 py-3 text-start font-medium">צילום</th>
                <th className="w-32 px-3 py-3 text-start font-medium">מיקום</th>
                <th className="w-52 px-3 py-3 text-start font-medium">שיוך נוכחי</th>
                <th className="w-32 px-3 py-3 text-start font-medium">מצב מלאי</th>
                <th className="w-24 px-3 py-3 text-start font-medium">עודכן</th>
                <th className="w-28 pe-4 ps-2 py-3" aria-label="פעולות" />
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {rows.map((r) => (
                <tr key={r.id} className={cn("group relative transition-colors hover:bg-stone-2", selected.has(r.id) && "bg-accent-soft/50 hover:bg-accent-soft/70")}>
                  <td className="relative z-10 ps-5 pe-1 py-2">
                    <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`בחירת ${r.inventoryNumber}`} className="size-4 accent-[var(--color-ink)]" />
                  </td>
                  <td className="px-2 py-2">
                    <span className="block size-10 overflow-hidden rounded-md bg-stone ring-1 ring-rule">
                      {r.thumbAssetId && <img src={`/api/assets/${r.thumbAssetId}/thumb`} alt="" loading="lazy" decoding="async" className="size-full object-cover" />}
                    </span>
                  </td>
                  <td className="px-2 py-2">
                    <span className="num font-mono text-[13px] font-semibold">{r.inventoryNumber}</span>
                    {r.barcode !== r.inventoryNumber && <div className="num font-mono text-[11px] text-muted" title="ברקוד חיצוני">{r.barcode}</div>}
                  </td>
                  <td className="max-w-0 px-3 py-2">
                    <Link href={`/inventory/${r.id}`} className="block truncate font-medium text-ink after:absolute after:inset-0">
                      {r.title}
                    </Link>
                    {r.author && <div className="truncate text-[12.5px] text-muted">{r.author}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <PhotoStatusBadge status={r.photoStatus} />
                    <div className="num mt-0.5 text-[11.5px] text-muted">{r.photoCount} תמונות</div>
                  </td>
                  <td className="px-3 py-2">
                    {r.location ? (
                      <span className="num font-mono text-[12.5px]" title={r.location.label}>
                        {r.location.code}
                      </span>
                    ) : (
                      <span className="text-[12.5px] text-faint">ללא מיקום</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {r.assignment === null ? (
                      <CommercialStatusBadge status={r.commercialStatus} />
                    ) : "hidden" in r.assignment ? (
                      <span className="text-[12.5px] text-muted">משויך לבית מכירות אחר</span>
                    ) : (
                      <div className="relative z-10">
                        <HouseMark name={r.assignment.house.name} color={r.assignment.house.accentColor} className="text-[12.5px]" />
                        <Link href={`/lots/${r.assignment.lotId}`} className="block text-[12.5px] text-ink-2 hover:underline">
                          קטלוג <span className="num">{r.assignment.catalog.number}</span> · פריט <span className="num">{r.assignment.lotNumber}</span>
                        </Link>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <PhysicalStatusBadge status={r.physicalStatus} />
                  </td>
                  <td className="px-3 py-2 text-[12.5px] text-muted" title={fmt.dateTime(r.updatedAt)} suppressHydrationWarning>
                    {fmt.relative(r.updatedAt)}
                  </td>
                  <td className="relative z-10 pe-4 ps-2 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {perms.capture && (
                        <ButtonLink href={`/capture/${r.id}`} size="sm" icon={<Camera className="text-accent" />} aria-label={`צילום ${r.inventoryNumber}`} className="opacity-80 group-hover:opacity-100">
                          צילום
                        </ButtonLink>
                      )}
                      <Menu
                        trigger={(p) => (
                          <IconButton label={`פעולות ל-${r.inventoryNumber}`} size="sm" {...p}>
                            <MoreHorizontal />
                          </IconButton>
                        )}
                        items={[
                          { label: "פתיחה והיסטוריה", icon: <Library />, onSelect: () => router.push(`/inventory/${r.id}`) },
                          ...(perms.label ? [{ label: "הדפסת תווית", icon: <Tag />, onSelect: () => printLabels([r.id]) }] : []),
                          ...(perms.assign && r.physicalStatus !== "SHIPPED" && r.commercialStatus !== "SOLD"
                            ? [{ label: r.assignment ? "שינוי שיוך לקטלוג" : "שיוך לקטלוג", icon: <Gavel />, onSelect: () => setAssignFor([r]) }]
                            : []),
                        ]}
                      />
                    </div>
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
            נבחרו <span className="num font-semibold">{selected.size}</span> ספרים
          </span>
          {perms.label && (
            <Button size="sm" className="border-white/15 bg-white/8 text-paper shadow-none hover:bg-white/14" icon={<Printer />} onClick={() => printLabels([...selected])}>
              הדפסת תוויות
            </Button>
          )}
          {perms.assign && (
            <Button size="sm" className="border-white/15 bg-white/8 text-paper shadow-none hover:bg-white/14" icon={<Gavel />} onClick={() => setAssignFor(chosen)}>
              שיוך לקטלוג
            </Button>
          )}
          <IconButton label="ניקוי בחירה" size="sm" className="text-white/60 hover:bg-white/10 hover:text-white" onClick={() => setSelected(new Set())}>
            <X />
          </IconButton>
        </div>
      )}

      {assignFor && (
        <AssignDialog
          open
          onClose={() => {
            setAssignFor(null);
            setSelected(new Set());
          }}
          items={assignFor.map((r) => ({ id: r.id, inventoryNumber: r.inventoryNumber, title: r.title }))}
          defaultHouse={defaultHouse}
        />
      )}
    </>
  );
}

interface Preview {
  rows: { line: number; title: string; author?: string }[];
  errors: { line: number; message: string }[];
  unknownColumns: string[];
  imported: number;
}

function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(file: File) {
    const text = await file.text();
    setCsv(text);
    try {
      setPreview(await api<Preview>("/api/inventory/import?dryRun=1", { method: "POST", body: text, headers: { "content-type": "text/csv" } }));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function run() {
    if (!csv) return;
    setBusy(true);
    try {
      const r = await api<Preview>("/api/inventory/import", { method: "POST", body: csv, headers: { "content-type": "text/csv" } });
      if (r.errors.length) {
        setPreview(r);
        return;
      }
      toast.success(`נקלטו ${r.imported} ספרים למלאי`);
      setCsv(null);
      setPreview(null);
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="ייבוא ספרים למלאי מ-CSV"
      description="עמודות מוכרות: שם ספר, מחבר, כותרת משנה, מקום דפוס, שנת דפוס, הוצאה, מצב, גובה, רוחב, עובי (מ״מ), ברקוד, הערות. כל שורה = עותק פיזי אחד. הייבוא כולו-או-כלום."
      width="lg"
    >
      <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-rule-strong bg-stone-2 px-4 py-8 text-[13.5px] text-ink-2 hover:border-ink/30 hover:bg-stone">
        <FileUp className="size-4" />
        בחירת קובץ CSV (UTF-8)
        <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      </label>
      {preview && (
        <div className="mt-4 space-y-3 text-[13px]">
          <p>
            <span className="num font-semibold">{preview.rows.length}</span> שורות תקינות · <span className="num font-semibold">{preview.errors.length}</span> שגיאות
            {preview.unknownColumns.length > 0 && <span className="text-muted"> · עמודות שלא זוהו: {preview.unknownColumns.join(", ")}</span>}
          </p>
          {preview.errors.length > 0 && (
            <ul className="max-h-40 overflow-y-auto rounded-md bg-danger-soft px-3 py-2 text-danger">
              {preview.errors.map((e, i) => (
                <li key={i}>
                  שורה <span className="num">{e.line}</span>: {e.message}
                </li>
              ))}
            </ul>
          )}
          <ul className="max-h-48 divide-y divide-rule overflow-y-auto rounded-md border border-rule">
            {preview.rows.slice(0, 50).map((r) => (
              <li key={r.line} className="flex gap-3 px-3 py-1.5">
                <span className="num w-8 text-muted">{r.line}</span>
                <span className="font-medium">{r.title}</span>
                {r.author && <span className="text-muted">{r.author}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-5 flex gap-2">
        <Button variant="primary" loading={busy} disabled={!preview || preview.errors.length > 0 || preview.rows.length === 0} onClick={run}>
          קליטת {preview?.rows.length ?? 0} ספרים
        </Button>
        <Button onClick={onClose}>ביטול</Button>
      </div>
    </Dialog>
  );
}
