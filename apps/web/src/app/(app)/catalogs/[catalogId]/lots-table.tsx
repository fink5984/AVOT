"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRightLeft, Ban, BookPlus, Camera, CircleCheck, CircleDashed, Copy, CornerDownLeft, Gavel, Library, MoreHorizontal, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { LOT_STATUSES, PHOTO_CATEGORIES, type CommercialStatus, type LotStatus, type PhotoCategory } from "@avot/shared";
import { Button, ButtonLink, IconButton } from "@/components/ui/button";
import { CommercialStatusBadge, LOT_TONE, LotStatusBadge, toneDot } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { Menu } from "@/components/ui/menu";

type MenuItems = React.ComponentProps<typeof Menu>["items"];
import { EmptyState, PageBody } from "@/components/ui/misc";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { LotFormDialog, type LotFormValue } from "@/components/lot-form-dialog";
import { AddFromInventoryDialog } from "@/components/inventory/add-from-inventory-dialog";
import { fmt, t } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";

export interface LotRow {
  id: string;
  lotNumber: number;
  sortOrder: number;
  title: string;
  subtitle: string | null;
  author: string | null;
  status: LotStatus;
  photoCount: number;
  counts: Record<PhotoCategory, number>;
  thumbAssetId: string | null;
  updatedAt: string;
  inventoryItemId: string;
  inventoryNumber: string;
  assignmentStatus: "ACTIVE" | "ENDED";
  commercialStatus: CommercialStatus;
  locationLabel: string | null;
}

type Sort = "number" | "title" | "updated" | "status";

export function LotsTable({
  catalogId,
  catalogLabel,
  lots,
  initialStatus,
  otherCatalogs,
  perms,
}: {
  catalogId: string;
  catalogLabel: string;
  lots: LotRow[];
  initialStatus: string;
  otherCatalogs: { id: string; number: string; name: string; house?: string }[];
  perms: { create: boolean; edit: boolean; status: boolean; capture: boolean; commercial?: boolean };
}) {
  const router = useRouter();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [sort, setSort] = useState<Sort>("number");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [quickTitle, setQuickTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editLot, setEditLot] = useState<LotFormValue | null>(null);
  const [moveIds, setMoveIds] = useState<string[] | null>(null);
  const [removeIds, setRemoveIds] = useState<string[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const quickRef = useRef<HTMLInputElement>(null);
  // one key per typed title: a retry after a failed / lost request reuses it, so the book is created once
  const quickOp = useRef<{ title: string; opId: string } | null>(null);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let rows = lots.filter((l) => status === "ALL" || l.status === status);
    if (needle) {
      rows = rows.filter(
        (l) =>
          String(l.lotNumber) === needle ||
          l.title.toLowerCase().includes(needle) ||
          l.subtitle?.toLowerCase().includes(needle) ||
          l.author?.toLowerCase().includes(needle) ||
          l.inventoryNumber.toLowerCase().includes(needle),
      );
    }
    const sorted = [...rows];
    if (sort === "number") sorted.sort((a, b) => a.lotNumber - b.lotNumber);
    if (sort === "title") sorted.sort((a, b) => a.title.localeCompare(b.title, "he"));
    if (sort === "updated") sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (sort === "status") sorted.sort((a, b) => LOT_STATUSES.indexOf(a.status) - LOT_STATUSES.indexOf(b.status) || a.lotNumber - b.lotNumber);
    return sorted;
  }, [lots, q, status, sort]);

  const statusCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lots) m.set(l.status, (m.get(l.status) ?? 0) + 1);
    return m;
  }, [lots]);

  const allChecked = visible.length > 0 && visible.every((l) => selected.has(l.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function quickAdd(e: React.FormEvent) {
    e.preventDefault();
    const title = quickTitle.trim();
    if (!title) return;
    if (adding) return;
    setAdding(true);
    if (quickOp.current?.title !== title) quickOp.current = { title, opId: crypto.randomUUID() };
    try {
      const r = await api<{ lot: { lotNumber: number } }>(`/api/catalogs/${catalogId}/lots`, { method: "POST", json: { title, opId: quickOp.current.opId } });
      toast.success(`נוסף ספר חדש: פריט ${r.lot.lotNumber} · ${title}`, { detail: "הספר נקלט גם למלאי" });
      quickOp.current = null;
      setQuickTitle("");
      router.refresh();
      quickRef.current?.focus();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAdding(false);
    }
  }

  async function bulkStatus(next: LotStatus) {
    const ids = [...selected];
    try {
      await Promise.all(ids.map((id) => api(`/api/lots/${id}`, { method: "PATCH", json: { status: next } })));
      toast.success(`${ids.length} פריטים סומנו כ"${t.lotStatus[next]}"`);
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
      router.refresh();
    }
  }

  async function openEdit(id: string) {
    try {
      const lot = await api<{ lot: LotFormValue }>(`/api/lots/${id}`);
      setEditLot(lot.lot);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function duplicate(id: string) {
    try {
      const r = await api<{ lot: { lotNumber: number } }>(`/api/lots/${id}/duplicate`, { method: "POST" });
      toast.success(`נוסף עותק פיזי נוסף: פריט ${r.lot.lotNumber}`, { detail: "נוצר ספר מלאי חדש עם אותם פרטים, ללא תמונות." });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function setCommercial(lot: LotRow, status: CommercialStatus) {
    const ends = status === "SOLD" || status === "UNSOLD" || status === "WITHDRAWN";
    if (ends && !window.confirm(`לסמן את פריט ${lot.lotNumber} כ"${t.commercialStatus[status]}"? השיוך לקטלוג יסתיים${status === "SOLD" ? " ותיווצר משימת ליקוט" : ""}.`)) return;
    try {
      await api(`/api/lots/${lot.id}/commercial`, { method: "POST", json: { status } });
      toast.success(`פריט ${lot.lotNumber}: ${t.commercialStatus[status]}`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function remove(lot: LotRow) {
    if (!window.confirm(`להסיר את פריט ${lot.lotNumber} · ${lot.title} מהקטלוג?\nהספר, התמונות וההיסטוריה שלו נשארים במלאי (${lot.inventoryNumber}).`)) return;
    try {
      await api(`/api/lots/${lot.id}`, { method: "DELETE" });
      toast.success("הפריט הוסר מהקטלוג", { detail: `הספר ${lot.inventoryNumber} נשאר במלאי` });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  function lotMenu(l: LotRow): MenuItems {
    const items: MenuItems = [];
    if (perms.edit) {
      items.push({ label: "עריכת פרטים", icon: <Pencil />, onSelect: () => openEdit(l.id) });
      items.push({ label: "עותק פיזי נוסף (ספר חדש)", icon: <Copy />, onSelect: () => duplicate(l.id) });
      if (otherCatalogs.length && l.assignmentStatus === "ACTIVE") items.push({ label: "העברה לקטלוג אחר", icon: <ArrowRightLeft />, onSelect: () => setMoveIds([l.id]) });
    }
    if (perms.commercial) {
      items.push("separator");
      if (l.assignmentStatus === "ACTIVE" && l.commercialStatus !== "OFFERED") items.push({ label: "הוצע למכירה", icon: <Gavel />, onSelect: () => setCommercial(l, "OFFERED") });
      if (l.commercialStatus !== "SOLD") items.push({ label: "נמכר", icon: <CircleCheck />, onSelect: () => setCommercial(l, "SOLD") });
      if (l.assignmentStatus === "ACTIVE") {
        items.push({ label: "לא נמכר", icon: <CircleDashed />, onSelect: () => setCommercial(l, "UNSOLD") });
        items.push({ label: "הוסר ממכירה", icon: <Ban />, onSelect: () => setCommercial(l, "WITHDRAWN") });
      }
    }
    if (perms.edit && l.commercialStatus === "ASSIGNED") {
      items.push("separator");
      items.push({ label: "הסרה מהקטלוג", icon: <Trash2 />, danger: true, onSelect: () => remove(l) });
    }
    return items;
  }

  return (
    <PageBody>
      {perms.create && (
        <form onSubmit={quickAdd} className="card mb-4 flex items-center gap-2 p-2 ps-4 focus-within:border-ink/40 focus-within:ring-[3px] focus-within:ring-ink/6">
          <Plus className="size-4.5 shrink-0 text-muted" aria-hidden />
          <input
            ref={quickRef}
            value={quickTitle}
            onChange={(e) => setQuickTitle(e.target.value)}
            placeholder="צור ספר חדש בקטלוג — הקלידו את שם הספר ולחצו Enter"
            className="h-9 min-w-0 flex-1 bg-transparent text-[14px] placeholder:text-faint focus:outline-none"
            aria-label="הוספה מהירה של פריט"
            maxLength={300}
          />
          <Button type="submit" variant="primary" size="sm" loading={adding} disabled={!quickTitle.trim()} icon={<CornerDownLeft />}>
            הוספה
          </Button>
          <Button onClick={() => setFormOpen(true)} variant="ghost" size="sm" icon={<BookPlus />} className="hidden sm:inline-flex">
            עם פרטים מלאים
          </Button>
          {perms.edit && (
            <Button onClick={() => setPickerOpen(true)} size="sm" icon={<Library />}>
              הוסף ספרים מהמלאי
            </Button>
          )}
        </form>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          variant="pill"
          label="סינון לפי מצב"
          value={status}
          onChange={setStatus}
          items={[
            { value: "ALL", label: "הכול", count: lots.length },
            ...LOT_STATUSES.filter((s) => statusCounts.get(s) || s === status).map((s) => ({
              value: s,
              label: (
                <span className="flex items-center gap-1.5">
                  <span className={cn("size-1.5 rounded-full", toneDot(LOT_TONE[s]))} aria-hidden />
                  {t.lotStatus[s]}
                </span>
              ),
              count: statusCounts.get(s) ?? 0,
            })),
          ]}
        />
        <div className="relative w-full sm:ms-auto sm:w-60">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="סינון: מספר, שם או מחבר" className="ps-9" aria-label="סינון פריטים" />
        </div>
        <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="w-full sm:w-44" aria-label="מיון">
          <option value="number">לפי מספר פריט</option>
          <option value="title">לפי שם</option>
          <option value="status">לפי מצב</option>
          <option value="updated">עודכנו לאחרונה</option>
        </Select>
      </div>

      <div className="card mt-4">
        {lots.length === 0 ? (
          <EmptyState
            icon={<BookPlus />}
            title="אין עדיין ספרים בקטלוג"
            action={
              perms.create && (
                <div className="flex gap-2">
                  <Button variant="primary" icon={<Library />} onClick={() => setPickerOpen(true)}>
                    הוסף ספרים מהמלאי
                  </Button>
                  <Button icon={<Plus />} onClick={() => quickRef.current?.focus()}>
                    צור ספר חדש
                  </Button>
                </div>
              )
            }
          >
            הקלידו שם ספר בשדה ההוספה שלמעלה, או ייבאו רשימה מקובץ CSV מתפריט ״עוד״.
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState title="אין פריטים התואמים לסינון" />
        ) : (
          <table className="w-full text-[13.5px]">
            <thead>
              <tr className="border-b border-rule text-[12.5px] text-muted">
                <th className="w-11 ps-5 pe-1 py-3">
                  <input
                    type="checkbox"
                    aria-label="בחירת הכול"
                    checked={allChecked}
                    onChange={() => setSelected(allChecked ? new Set() : new Set(visible.map((l) => l.id)))}
                    className="size-4 accent-[var(--color-ink)]"
                  />
                </th>
                <th className="w-16 px-2 py-3" aria-label="תמונה" />
                <th className="w-16 px-2 py-3 text-start font-medium">פריט</th>
                <th className="px-3 py-3 text-start font-medium">שם הספר</th>
                <th className="hidden w-36 px-3 py-3 text-start font-medium md:table-cell">צילום</th>
                <th className="w-32 px-3 py-3 text-start font-medium">מסחרי</th>
                {PHOTO_CATEGORIES.map((c) => (
                  <th key={c} className="hidden w-14 px-1 py-3 text-center font-medium 2xl:table-cell" title={t.category[c]}>
                    {t.categoryShort[c]}
                  </th>
                ))}
                <th className="w-14 px-2 py-3 text-center font-medium">סה״כ</th>
                <th className="hidden w-24 px-3 py-3 text-start font-medium xl:table-cell">עודכן</th>
                <th className="w-32 pe-4 ps-2 py-3" aria-label="פעולות" />
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {visible.map((l) => (
                <tr
                  key={l.id}
                  className={cn(
                    "group relative transition-colors hover:bg-stone-2 [content-visibility:auto] [contain-intrinsic-size:auto_60px]",
                    selected.has(l.id) && "bg-accent-soft/50 hover:bg-accent-soft/70",
                  )}
                >
                  <td className="relative z-10 ps-5 pe-1 py-2">
                    <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} aria-label={`בחירת פריט ${l.lotNumber}`} className="size-4 accent-[var(--color-ink)]" />
                  </td>
                  <td className="px-2 py-2">
                    <span className="block size-11 overflow-hidden rounded-md bg-stone ring-1 ring-rule">
                      {l.thumbAssetId && <img src={`/api/assets/${l.thumbAssetId}/thumb`} alt="" loading="lazy" decoding="async" className="size-full object-cover" />}
                    </span>
                  </td>
                  <td className="px-2 py-2">
                    <span className="num text-[15px] font-semibold">{l.lotNumber}</span>
                  </td>
                  <td className="max-w-0 px-3 py-2">
                    {/* stretched link: clicking anywhere on the row opens the book */}
                    <Link href={`/lots/${l.id}`} className="block truncate font-medium text-ink after:absolute after:inset-0">
                      {l.title}
                    </Link>
                    <div className="truncate text-[12.5px] text-muted">
                      <span className="num font-mono text-[11.5px] text-ink-2">{l.inventoryNumber}</span>
                      {l.locationLabel && <span className="ms-2 text-[11.5px]">{l.locationLabel}</span>}
                      {(l.subtitle || l.author) && <span> · {[l.author, l.subtitle].filter(Boolean).join(" · ")}</span>}
                    </div>
                  </td>
                  <td className="hidden px-3 py-2 md:table-cell">
                    <LotStatusBadge status={l.status} />
                  </td>
                  <td className="px-3 py-2">
                    <CommercialStatusBadge status={l.commercialStatus} className={cn(l.assignmentStatus === "ENDED" && "opacity-70")} />
                  </td>
                  {PHOTO_CATEGORIES.map((c) => (
                    <td key={c} className={cn("num hidden px-1 py-2 text-center 2xl:table-cell", l.counts[c] ? "font-medium text-ink" : "text-faint")}>
                      {l.counts[c] || "·"}
                    </td>
                  ))}
                  <td className="num px-2 py-2 text-center font-semibold">{l.photoCount}</td>
                  <td className="hidden px-3 py-2 text-[12.5px] text-muted xl:table-cell" title={fmt.dateTime(l.updatedAt)}>
                    {fmt.relative(l.updatedAt)}
                  </td>
                  <td className="relative z-10 pe-4 ps-2 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {perms.capture && (
                        <ButtonLink
                          href={`/capture/${l.id}`}
                          size="sm"
                          variant="secondary"
                          icon={<Camera className="text-accent" />}
                          aria-label={`צילום פריט ${l.lotNumber}`}
                          className="opacity-80 group-hover:opacity-100"
                        >
                          צילום
                        </ButtonLink>
                      )}
                      {(perms.edit || perms.commercial) && (
                        <Menu
                          trigger={(p) => (
                            <IconButton label={`פעולות לפריט ${l.lotNumber}`} size="sm" {...p}>
                              <MoreHorizontal />
                            </IconButton>
                          )}
                          items={lotMenu(l)}
                        />
                      )}
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
            נבחרו <span className="num font-semibold">{selected.size}</span> פריטים
          </span>
          {perms.status && (
            <select
              className="h-8 rounded-md border border-white/15 bg-white/8 px-2 text-[13px] text-paper"
              value=""
              onChange={(e) => e.target.value && bulkStatus(e.target.value as LotStatus)}
              aria-label="שינוי מצב לפריטים שנבחרו"
            >
              <option value="">שינוי מצב…</option>
              {LOT_STATUSES.map((s) => (
                <option key={s} value={s} className="text-ink">
                  {t.lotStatus[s]}
                </option>
              ))}
            </select>
          )}
          {perms.edit && otherCatalogs.length > 0 && (
            <Button size="sm" className="border-white/15 bg-white/8 text-paper shadow-none hover:bg-white/14" icon={<ArrowRightLeft />} onClick={() => setMoveIds([...selected])}>
              העברה לקטלוג אחר
            </Button>
          )}
          {perms.edit && (
            <Button size="sm" className="border-white/15 bg-white/8 text-paper shadow-none hover:bg-white/14" icon={<Trash2 />} onClick={() => setRemoveIds([...selected])}>
              הסרה מהקטלוג
            </Button>
          )}
          <IconButton label="ניקוי בחירה" size="sm" className="text-white/60 hover:bg-white/10 hover:text-white" onClick={() => setSelected(new Set())}>
            <X />
          </IconButton>
        </div>
      )}

      <AddFromInventoryDialog open={pickerOpen} onClose={() => setPickerOpen(false)} catalogId={catalogId} catalogLabel={catalogLabel} />
      <RemoveLotsDialog catalogId={catalogId} ids={removeIds} lots={lots} onClose={() => setRemoveIds(null)} onDone={() => setSelected(new Set())} />
      <LotFormDialog open={formOpen} onClose={() => setFormOpen(false)} catalogId={catalogId} />
      {editLot && <LotFormDialog open onClose={() => setEditLot(null)} catalogId={catalogId} initial={editLot} />}
      <MoveLotsDialog ids={moveIds} onClose={() => setMoveIds(null)} catalogs={otherCatalogs} onDone={() => setSelected(new Set())} />
    </PageBody>
  );
}

function MoveLotsDialog({
  ids,
  onClose,
  catalogs,
  onDone,
}: {
  ids: string[] | null;
  onClose: () => void;
  catalogs: { id: string; number: string; name: string; house?: string }[];
  onDone: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [target, setTarget] = useState(catalogs[0]?.id ?? "");
  const [busy, setBusy] = useState(false);

  async function move() {
    if (!ids) return;
    setBusy(true);
    try {
      for (const id of ids) await api(`/api/lots/${id}/move`, { method: "POST", json: { catalogId: target } });
      toast.success(`${ids.length} ספרים שויכו לקטלוג היעד`, { detail: "השיוך הקודם נשמר בהיסטוריה; התמונות והמיקום במחסן לא השתנו." });
      onDone();
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={!!ids}
      onClose={onClose}
      title="העברת פריטים לקטלוג אחר"
      description="השיוך הנוכחי יסתיים (״הוסר ממכירה״) ויישמר בהיסטוריה. הספרים יקבלו את המספרים הפנויים הבאים בקטלוג היעד, עם כל התמונות שלהם."
      width="sm"
    >
      <Field label="קטלוג יעד">
        {(p) => (
          <Select {...p} value={target} onChange={(e) => setTarget(e.target.value)}>
            {catalogs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.house ? `${c.house} · ` : ""}
                {c.number} · {c.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="mt-6 flex gap-2">
        <Button variant="primary" loading={busy} onClick={move} disabled={!target}>
          העברת {ids?.length ?? 0} פריטים
        </Button>
        <Button onClick={onClose}>ביטול</Button>
      </div>
    </Dialog>
  );
}

/** Removing items from a catalog never deletes the books: one confirmation, one request, a per-item report. */
function RemoveLotsDialog({ catalogId, ids, lots, onClose, onDone }: { catalogId: string; ids: string[] | null; lots: LotRow[]; onClose: () => void; onDone: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const chosen = lots.filter((l) => ids?.includes(l.id));

  async function run() {
    if (!ids) return;
    setBusy(true);
    try {
      const r = await api<{ done: string[]; failed: { lotId: string; message: string }[] }>(`/api/catalogs/${catalogId}/lots/bulk-remove`, { method: "POST", json: { lotIds: ids } });
      if (r.failed.length) toast.warning(`${r.done.length} הוסרו · ${r.failed.length} לא הוסרו`, { detail: r.failed.slice(0, 2).map((f) => f.message).join(" · ") });
      else toast.success(`${r.done.length} פריטים הוסרו מהקטלוג`, { detail: "הספרים והתמונות נשארו במלאי" });
      onDone();
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!ids} onClose={onClose} title={`הסרת ${chosen.length} פריטים מהקטלוג`} width="sm">
      <p className="text-[13.5px] leading-relaxed">
        הפריטים יוסרו מהקטלוג בלבד. <b>הספרים, התמונות והמיקום במחסן נשארים במלאי.</b> פריטים שיש להם מצב מסחרי (הוצע / נמכר) לא יוסרו.
      </p>
      <div className="mt-5 flex gap-2">
        <Button variant="danger" loading={busy} onClick={run}>
          הסרה מהקטלוג
        </Button>
        <Button onClick={onClose}>ביטול</Button>
      </div>
    </Dialog>
  );
}
