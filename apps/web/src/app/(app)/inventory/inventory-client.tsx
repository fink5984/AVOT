"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookPlus, Camera, FileUp, Gavel, Library, Loader2, MapPin, MoreHorizontal, Plus, Printer, Tag, Trash2, X } from "lucide-react";
import type { CommercialStatus, LotStatus, PhysicalStatus } from "@avot/shared";
import { Button, IconButton, IconButtonLink } from "@/components/ui/button";
import { CommercialStatusBadge, PhotoStatusBadge, PhysicalStatusBadge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Menu } from "@/components/ui/menu";
import { EmptyState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { HouseMark } from "@/components/house-mark";
import { AssignDialog } from "@/components/inventory/assign-dialog";
import { ItemFormDialog } from "@/components/inventory/item-form-dialog";
import { fmt } from "@/i18n";
import { ApiError, api, errorMessage } from "@/lib/api";
import { usePrintLabels } from "@/lib/print";
import { LocationDialog } from "@/components/warehouse/location-dialog";
import { DeleteDialog } from "@/components/deletion/delete-dialog";
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
          הוספה עם פרטים
        </Button>
      )}
      <ItemFormDialog open={open} onClose={() => setOpen(false)} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}

/** One book as the table shows it. */
function rowFromCreated(item: { id: string; inventoryNumber: string; barcode: string; title: string; author: string | null; photoStatus: LotStatus; physicalStatus: PhysicalStatus; commercialStatus: CommercialStatus; updatedAt: string }): InventoryRowDto {
  return {
    id: item.id,
    inventoryNumber: item.inventoryNumber,
    barcode: item.barcode,
    title: item.title,
    author: item.author,
    photoStatus: item.photoStatus,
    physicalStatus: item.physicalStatus,
    commercialStatus: item.commercialStatus,
    photoCount: 0,
    thumbAssetId: null,
    location: null,
    assignment: null,
    updatedAt: item.updatedAt,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The fixed "הקלד שם ספר ולחץ Enter להוספה…" row. Enter clears the field and keeps the focus there, the new
 * book appears at the top at once, and requests go out one at a time. Every request carries its own key
 * (opId): a double Enter, a retry after a lost response or a second tab can never create a second book.
 */
function QuickAdd({ onAdded }: { onAdded: (row: InventoryRowDto) => void }) {
  const toast = useToast();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(0);
  const [last, setLast] = useState<{ number: string; title: string } | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const lastSubmit = useRef<{ title: string; at: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function create(title: string, opId: string) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await api<{ item: Parameters<typeof rowFromCreated>[0]; existing: boolean }>("/api/inventory", { method: "POST", json: { title, opId } });
        onAdded(rowFromCreated(r.item));
        setLast({ number: r.item.inventoryNumber, title: r.item.title });
        return;
      } catch (err) {
        // no connection: the same opId is retried, so a request that did reach the server is not repeated
        if (err instanceof ApiError && err.status === 0 && attempt < 3) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        toast.error(`"${title}" לא נוסף: ${errorMessage(err)}`);
        setValue((v) => v || title);
        return;
      }
    }
  }

  function submit() {
    const title = value.trim();
    if (!title) return;
    const prev = lastSubmit.current;
    const now = Date.now();
    if (prev && prev.title === title && now - prev.at < 700) return; // key bounce / double press
    lastSubmit.current = { title, at: now };
    setValue("");
    const opId = crypto.randomUUID();
    setPending((n) => n + 1);
    chain.current = chain.current.then(() => create(title, opId)).finally(() => setPending((n) => n - 1));
    input.current?.focus();
  }

  return (
    <div className="mb-3">
      <div className="relative">
        <Plus className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
        <input
          ref={input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          maxLength={300}
          enterKeyHint="done"
          autoComplete="off"
          aria-label="הוספת ספר חדש למלאי"
          placeholder="הקלד שם ספר ולחץ Enter להוספה..."
          className="h-11 w-full rounded-lg border border-rule-strong bg-paper ps-10 pe-24 text-[14.5px] shadow-card placeholder:text-faint hover:border-[#c6c2b8] focus:border-ink/50 focus:outline-none focus:ring-[3px] focus:ring-ink/8"
        />
        {pending > 0 && (
          <span className="absolute end-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5 text-[12px] text-muted" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            שומר…
          </span>
        )}
      </div>
      <div className="mt-1 h-4 px-1 text-[12px] text-muted" aria-live="polite">
        {last && (
          <>
            נוסף <span className="num font-mono">{last.number}</span> · {last.title}
          </>
        )}
      </div>
    </div>
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
  perms: { capture: boolean; assign: boolean; label: boolean; edit: boolean; create: boolean; delete: boolean; relocate: boolean };
  defaultHouse: string | null;
}) {
  const router = useRouter();
  const print = usePrintLabels();
  const [added, setAdded] = useState<InventoryRowDto[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignFor, setAssignFor] = useState<InventoryRowDto[] | null>(null);
  const [locationFor, setLocationFor] = useState<InventoryRowDto[] | null>(null);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);

  // rows from the server replace the optimistic ones whenever the list is reloaded
  useEffect(() => setAdded([]), [rows]);
  const all = useMemo(() => [...added.filter((a) => !rows.some((r) => r.id === a.id)), ...rows], [added, rows]);
  const shownTotal = total + added.filter((a) => !rows.some((r) => r.id === a.id)).length;

  const allChecked = all.length > 0 && all.every((r) => selected.has(r.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const chosen = all.filter((r) => selected.has(r.id));
  const asItems = (rs: InventoryRowDto[]) => rs.map((r) => ({ id: r.id, inventoryNumber: r.inventoryNumber, title: r.title }));
  const printBooks = (rs: InventoryRowDto[]) => print(rs.map((r) => ({ type: "BOOK" as const, id: r.id })), { what: rs.length === 1 ? `תווית ${rs[0]!.inventoryNumber}` : undefined });
  const canAssign = (r: InventoryRowDto) => perms.assign && r.physicalStatus !== "SHIPPED" && r.commercialStatus !== "SOLD";

  return (
    <>
      <div className="mt-4">
        {perms.create && <QuickAdd onAdded={(row) => setAdded((a) => [row, ...a])} />}
        <div className="card overflow-hidden">
          {all.length === 0 ? (
            <EmptyState icon={<Library />} title={shownTotal === 0 ? "אין ספרים בתצוגה זו" : "אין תוצאות"}>
              {perms.create ? "הקלידו שם ספר בשורה שלמעלה ולחצו Enter. הספר נקלט עם מספר מלאי וברקוד קבועים." : "אין ספרים להצגה."}
            </EmptyState>
          ) : (
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="border-b border-rule text-[12.5px] text-muted">
                  <th className="w-10 ps-4 pe-1 py-2.5">
                    <input type="checkbox" aria-label="בחירת הכול" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(all.map((r) => r.id)))} className="size-4 accent-[var(--color-ink)]" />
                  </th>
                  <th className="w-12 px-1 py-2.5" aria-label="תמונה" />
                  <th className="px-2 py-2.5 text-start font-medium">שם הספר</th>
                  <th className="hidden w-28 px-2 py-2.5 text-start font-medium md:table-cell">צילום</th>
                  <th className="hidden w-32 px-2 py-2.5 text-start font-medium lg:table-cell">מיקום</th>
                  <th className="hidden w-48 px-2 py-2.5 text-start font-medium xl:table-cell">קטלוג</th>
                  <th className="w-px pe-3 ps-2 py-2.5" aria-label="פעולות" />
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {all.map((r) => (
                  <tr key={r.id} className={cn("group relative transition-colors hover:bg-stone-2", selected.has(r.id) && "bg-accent-soft/50 hover:bg-accent-soft/70")}>
                    <td className="relative z-10 ps-4 pe-1 py-1.5">
                      <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`בחירת ${r.inventoryNumber}`} className="size-4 accent-[var(--color-ink)]" />
                    </td>
                    <td className="px-1 py-1.5">
                      <span className="block size-9 overflow-hidden rounded-md bg-stone ring-1 ring-rule">
                        {r.thumbAssetId && <img src={`/api/assets/${r.thumbAssetId}/thumb`} alt="" loading="lazy" decoding="async" className="size-full object-cover" />}
                      </span>
                    </td>
                    <td className="max-w-0 px-2 py-1.5">
                      <Link href={`/inventory/${r.id}`} className="block truncate font-medium text-ink after:absolute after:inset-0">
                        {r.title}
                      </Link>
                      <div className="flex items-center gap-2 truncate text-[12px] text-muted">
                        <span className="num font-mono">{r.inventoryNumber}</span>
                        {r.barcode !== r.inventoryNumber && <span className="num font-mono" title="ברקוד חיצוני">{r.barcode}</span>}
                        {r.author && <span className="truncate">{r.author}</span>}
                        <span className="md:hidden">
                          <PhotoStatusBadge status={r.photoStatus} />
                        </span>
                      </div>
                    </td>
                    <td className="hidden px-2 py-1.5 md:table-cell">
                      <PhotoStatusBadge status={r.photoStatus} />
                      <div className="num mt-0.5 text-[11.5px] text-muted">{r.photoCount} תמונות</div>
                    </td>
                    <td className="hidden px-2 py-1.5 lg:table-cell">
                      {r.location ? (
                        <span className="num font-mono text-[12.5px]" title={r.location.label}>
                          {r.location.code}
                        </span>
                      ) : (
                        <span className="text-[12.5px] text-faint">ללא מיקום</span>
                      )}
                      {r.physicalStatus !== "IN_STORAGE" && r.physicalStatus !== "AWAITING_STORAGE" && (
                        <div className="mt-0.5">
                          <PhysicalStatusBadge status={r.physicalStatus} />
                        </div>
                      )}
                    </td>
                    <td className="hidden px-2 py-1.5 xl:table-cell">
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
                    <td className="relative z-10 pe-3 ps-2 py-1">
                      <div className="flex items-center justify-end gap-0.5">
                        {perms.capture && (
                          <IconButtonLink href={`/capture/${r.id}`} label={`צילום ${r.inventoryNumber}`}>
                            <Camera className="text-accent" />
                          </IconButtonLink>
                        )}
                        {perms.label && (
                          <IconButton label={`הדפסת תווית ${r.inventoryNumber}`} size="sm" onClick={() => void printBooks([r])}>
                            <Printer />
                          </IconButton>
                        )}
                        {canAssign(r) && (
                          <IconButton label={r.assignment ? "שינוי שיוך לקטלוג" : "שייך לקטלוג"} size="sm" onClick={() => setAssignFor([r])}>
                            <Gavel />
                          </IconButton>
                        )}
                        {perms.relocate && (
                          <IconButton label="שנה מיקום" size="sm" onClick={() => setLocationFor([r])}>
                            <MapPin />
                          </IconButton>
                        )}
                        <Menu
                          trigger={(p) => (
                            <IconButton label={`פעולות נוספות ל-${r.inventoryNumber}`} size="sm" {...p}>
                              <MoreHorizontal />
                            </IconButton>
                          )}
                          items={[
                            { label: "פתיחה והיסטוריה", icon: <Library />, onSelect: () => router.push(`/inventory/${r.id}`) },
                            ...(perms.label ? [{ label: "תווית להדפסה ידנית (PDF / ZPL)", icon: <Tag />, onSelect: () => router.push(`/labels/books?ids=${r.id}`) }] : []),
                            ...(perms.delete ? (["separator", { label: "מחיקה לצמיתות", icon: <Trash2 />, danger: true, onSelect: () => setDeleteIds([r.id]) }] as const) : []),
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
      </div>

      {selected.size > 0 && (
        <div className="animate-pop fixed inset-x-0 bottom-6 z-30 mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 rounded-xl bg-ink py-2 pe-2 ps-4 text-[13.5px] text-paper shadow-pop ring-1 ring-white/10">
          <span>
            נבחרו <span className="num font-semibold">{selected.size}</span> ספרים
          </span>
          {perms.label && (
            <Button size="sm" className="border-white/15 bg-white/8 text-paper shadow-none hover:bg-white/14" icon={<Printer />} onClick={() => void printBooks(chosen)}>
              הדפסת תוויות
            </Button>
          )}
          {perms.assign && (
            <Button size="sm" className="border-white/15 bg-white/8 text-paper shadow-none hover:bg-white/14" icon={<Gavel />} onClick={() => setAssignFor(chosen)}>
              שיוך לקטלוג
            </Button>
          )}
          {perms.relocate && (
            <Button size="sm" className="border-white/15 bg-white/8 text-paper shadow-none hover:bg-white/14" icon={<MapPin />} onClick={() => setLocationFor(chosen)}>
              שינוי מיקום
            </Button>
          )}
          {perms.delete && (
            <Button size="sm" className="border-danger/50 bg-danger/20 text-white shadow-none hover:bg-danger/35" icon={<Trash2 />} onClick={() => setDeleteIds(chosen.map((c) => c.id))}>
              מחיקה
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
          items={asItems(assignFor)}
          defaultHouse={defaultHouse}
        />
      )}
      {locationFor && <LocationDialog open onClose={() => setLocationFor(null)} items={asItems(locationFor)} onDone={() => setSelected(new Set())} />}
      {deleteIds && <DeleteDialog kind="books" open ids={deleteIds} onClose={() => setDeleteIds(null)} onDone={() => setSelected(new Set())} />}
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
