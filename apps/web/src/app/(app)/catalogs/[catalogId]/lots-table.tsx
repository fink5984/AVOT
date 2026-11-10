"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRightLeft, Ban, SlidersHorizontal, BookPlus, Camera, CircleCheck, CircleDashed, Copy, CornerDownLeft, Gavel, Layers, Library, MoreHorizontal, Pencil, Plus, Search, Sparkles, Trash2, X } from "lucide-react";
import { LOT_STATUSES, PHOTO_CATEGORIES, type CommercialStatus, type ItemReviewStatus, type LotStatus, type PhotoCategory } from "@avot/shared";
import type { LotReview } from "@/server/services/lots";
import { Button, ButtonLink, IconButton } from "@/components/ui/button";
import { CommercialStatusBadge, LOT_TONE, LotStatusBadge, ReviewStatusBadge, toneDot } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { Menu } from "@/components/ui/menu";

type MenuItems = React.ComponentProps<typeof Menu>["items"];
import { EmptyState, PageBody } from "@/components/ui/misc";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { LotFormDialog, type LotFormValue } from "@/components/lot-form-dialog";
import { AddFromInventoryDialog } from "@/components/inventory/add-from-inventory-dialog";
import { QuickBookDialog } from "@/components/consignors/quick-book-dialog";
import { ConsignorPickDialog } from "@/components/consignors/consignor-pick-dialog";
import { MergeLotsDialog } from "./merge-lots-dialog";
import { AiAnalyzeButton, type AiButtonState } from "@/components/ai/ai-button";
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
  /** 1 for an ordinary lot, 2+ for a combined lot */
  bookCount: number;
  books: { itemId: string; inventoryNumber: string; title: string; locationLabel: string | null; consignorId: string | null; ai: AiButtonState }[];
  consignorId: string | null;
  consignorName: string | null;
  /** the book's review state, from the inventory (never stored on the lot); aggregated for a combined lot */
  review: LotReview;
  bibliography: { author: string | null; printPlace: string | null; printYear: string | null };
}

type Sort = "number" | "title" | "updated" | "status" | "review";
type ReviewFilter = "ALL" | ItemReviewStatus;
/** the books that need a person first */
const REVIEW_ORDER: ItemReviewStatus[] = ["PENDING_REVIEW", "IN_REVIEW", "NOT_STARTED", "APPROVED"];
const REVIEW_FILTER_LABEL: Record<ReviewFilter, string> = { ALL: "הכול", PENDING_REVIEW: "ממתין לבדיקה", IN_REVIEW: "בבדיקה", APPROVED: "מאושר", NOT_STARTED: "טרם נותח" };

/** "מחבר · מקום · שנה" */
const identLine = (l: LotRow) => [l.bibliography.author ?? l.author, l.bibliography.printPlace, l.bibliography.printYear].filter(Boolean).join(" · ");

/** the quiet line under the review badge: who edited / approved, or the per-book tally of a combined lot */
function reviewNote(r: LotReview): string | null {
  if (r.total > 1) {
    return [`${r.total} ספרים`, `${r.approved} מאושרים`, r.inReview ? `${r.inReview} בבדיקה` : null, r.pending ? `${r.pending} ממתינים` : null, r.notStarted ? `${r.notStarted} טרם נותחו` : null].filter(Boolean).join(" · ");
  }
  if (r.status === "APPROVED" && r.approvedBy) return `מאושר - ${r.approvedBy}${r.approvedAt ? `, ${fmt.date(r.approvedAt)}` : ""}`;
  if (r.lastEditBy) return `נערך לאחרונה על ידי ${r.lastEditBy}`;
  return null;
}

function ReviewCell({ review }: { review: LotReview }) {
  const note = reviewNote(review);
  return (
    <div className="min-w-0">
      <ReviewStatusBadge status={review.status} />
      {note && <div className="mt-0.5 text-[11.5px] leading-snug text-muted">{note}</div>}
      {review.lastEditAt && review.total === 1 && review.status !== "APPROVED" && <div className="text-[11px] text-faint">{fmt.relative(review.lastEditAt)}</div>}
    </div>
  );
}

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
  perms: { create: boolean; edit: boolean; status: boolean; capture: boolean; commercial?: boolean; assign?: boolean; ai?: boolean };
}) {
  const router = useRouter();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [sort, setSort] = useState<Sort>("number");
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("ALL");
  /** phones: the status / review / sort controls live behind one button */
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [quickTitle, setQuickTitle] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  const [dupFor, setDupFor] = useState<LotRow | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editLot, setEditLot] = useState<LotFormValue | null>(null);
  const [moveIds, setMoveIds] = useState<string[] | null>(null);
  const [removeIds, setRemoveIds] = useState<string[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [aiLot, setAiLot] = useState<LotRow | null>(null);
  const quickRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let rows = lots.filter((l) => (status === "ALL" || l.status === status) && (reviewFilter === "ALL" || l.review.status === reviewFilter));
    if (needle) {
      rows = rows.filter(
        (l) =>
          String(l.lotNumber) === needle ||
          l.title.toLowerCase().includes(needle) ||
          l.subtitle?.toLowerCase().includes(needle) ||
          l.author?.toLowerCase().includes(needle) ||
          l.inventoryNumber.toLowerCase().includes(needle) ||
          l.books.some((b) => b.inventoryNumber.toLowerCase().includes(needle) || b.title.toLowerCase().includes(needle)),
      );
    }
    const sorted = [...rows];
    if (sort === "number") sorted.sort((a, b) => a.lotNumber - b.lotNumber);
    if (sort === "title") sorted.sort((a, b) => a.title.localeCompare(b.title, "he"));
    if (sort === "updated") sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (sort === "review") sorted.sort((a, b) => REVIEW_ORDER.indexOf(a.review.status) - REVIEW_ORDER.indexOf(b.review.status) || a.lotNumber - b.lotNumber);
    if (sort === "status") sorted.sort((a, b) => LOT_STATUSES.indexOf(a.status) - LOT_STATUSES.indexOf(b.status) || a.lotNumber - b.lotNumber);
    return sorted;
  }, [lots, q, status, sort, reviewFilter]);

  const statusCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lots) m.set(l.status, (m.get(l.status) ?? 0) + 1);
    return m;
  }, [lots]);

  const reviewCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lots) m.set(l.review.status, (m.get(l.review.status) ?? 0) + 1);
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

  /** Enter on the quick row: ask for the consignor first, then the book is created (the window keeps the retry key) */
  function quickAdd(e: React.FormEvent) {
    e.preventDefault();
    const title = quickTitle.trim();
    if (title && asking === null) setAsking(title);
  }

  async function quickCreate(v: { title: string; consignor: { id: string; name: string }; opId: string }) {
    const r = await api<{ lot: { lotNumber: number } }>(`/api/catalogs/${catalogId}/lots`, { method: "POST", json: { title: v.title, consignorId: v.consignor.id, opId: v.opId } });
    toast.success(`נוסף ספר חדש: פריט ${r.lot.lotNumber} · ${v.title}`, { detail: `הספר נקלט גם למלאי · מפקיד: ${v.consignor.name}` });
    setQuickTitle("");
    router.refresh();
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

  async function duplicate(id: string, consignor: { id: string; name: string }) {
    const r = await api<{ lot: { lotNumber: number } }>(`/api/lots/${id}/duplicate`, { method: "POST", json: { consignorId: consignor.id } });
    toast.success(`נוסף עותק פיזי נוסף: פריט ${r.lot.lotNumber}`, { detail: `נוצר ספר מלאי חדש עם אותם פרטים, ללא תמונות · מפקיד: ${consignor.name}` });
    router.refresh();
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
      if (l.bookCount < 2) items.push({ label: "עותק פיזי נוסף (ספר חדש)", icon: <Copy />, onSelect: () => setDupFor(l) });
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

  /** the lot's buttons: AI analysis and the "more" menu (same in the table and on a phone card) */
  function lotActions(l: LotRow) {
    return (
      <>
        {perms.ai && l.bookCount < 2 && l.books[0] && <AiAnalyzeButton itemId={l.books[0].itemId} inventoryNumber={l.books[0].inventoryNumber} initial={l.books[0].ai} size="sm" />}
        {perms.ai && l.bookCount > 1 && (
          <IconButton label={`ניתוח AI לפי ספר בלוט ${l.lotNumber}`} size="sm" onClick={() => setAiLot(l)}>
            <Sparkles className="text-info" />
          </IconButton>
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
      </>
    );
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
          <Button type="submit" variant="primary" size="sm" disabled={!quickTitle.trim()} icon={<CornerDownLeft />}>
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
        <div className="relative min-w-0 flex-1 sm:order-3 sm:ms-auto sm:flex-none sm:w-60">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="סינון: מספר, שם או מחבר" className="ps-9" aria-label="סינון פריטים" />
        </div>
        <Button className="sm:hidden" icon={<SlidersHorizontal />} onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen}>
          סינון ומיון
        </Button>
        <div className={cn("w-full flex-wrap items-center gap-2 sm:order-1 sm:flex sm:w-auto", filtersOpen ? "flex" : "hidden")}>
          <Tabs
            variant="pill"
            label="סינון לפי מצב צילום"
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
          <Select value={reviewFilter} onChange={(e) => setReviewFilter(e.target.value as ReviewFilter)} className="w-full sm:w-44" aria-label="סינון לפי מצב בדיקת פרטים">
            {(Object.keys(REVIEW_FILTER_LABEL) as ReviewFilter[]).map((k) => (
              <option key={k} value={k}>
                {k === "ALL" ? "בדיקת פרטים: הכול" : `${REVIEW_FILTER_LABEL[k]} (${reviewCounts.get(k) ?? 0})`}
              </option>
            ))}
          </Select>
          <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="w-full sm:w-44" aria-label="מיון">
            <option value="number">לפי מספר פריט</option>
            <option value="review">לפי מצב בדיקת פרטים (דורשים טיפול קודם)</option>
            <option value="title">לפי שם</option>
            <option value="status">לפי מצב צילום</option>
            <option value="updated">עודכנו לאחרונה</option>
          </Select>
        </div>
      </div>
      <p className="mt-2 text-[12.5px] text-muted" aria-live="polite">
        <span className="num">{visible.length}</span> מתוך <span className="num">{lots.length}</span> פריטים
      </p>

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
          <>
            {/* phones: one card per lot */}
            <ul className="divide-y divide-rule md:hidden">
              {visible.map((l) => (
                <li key={l.id} className={cn("relative flex gap-3 px-3 py-3", selected.has(l.id) && "bg-accent-soft/50")}>
                  <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} aria-label={`בחירת פריט ${l.lotNumber}`} className="relative z-10 mt-1 size-5 shrink-0 accent-[var(--color-ink)]" />
                  <span className="block size-16 shrink-0 overflow-hidden rounded-md bg-stone ring-1 ring-rule">
                    {l.thumbAssetId && <img src={`/api/assets/${l.thumbAssetId}/thumb`} alt="" loading="lazy" decoding="async" className="size-full object-cover" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-2">
                      <span className="num rounded bg-stone px-1.5 text-[13px] font-semibold">{l.lotNumber}</span>
                      <Link href={`/lots/${l.id}`} className="min-w-0 flex-1 text-[14.5px] font-medium leading-snug text-ink after:absolute after:inset-0">
                        {l.title}
                      </Link>
                    </div>
                    {identLine(l) && <div className="mt-0.5 text-[12.5px] text-muted">{identLine(l)}</div>}
                    <div className="num mt-0.5 font-mono text-[11.5px] text-ink-2">
                      {l.bookCount > 1 ? `${l.bookCount} ספרים · ` : ""}
                      {l.bookCount > 1 ? l.books.map((b) => b.inventoryNumber).join(" · ") : l.inventoryNumber}
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-1.5">
                      <ReviewCell review={l.review} />
                      <div className="flex flex-wrap items-center gap-1.5">
                        <LotStatusBadge status={l.status} />
                        <CommercialStatusBadge status={l.commercialStatus} className={cn(l.assignmentStatus === "ENDED" && "opacity-70")} />
                        <span className="text-[11.5px] text-muted">
                          <span className="num">{l.photoCount}</span> תמונות
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="relative z-10 flex shrink-0 flex-col items-center gap-1">{lotActions(l)}</div>
                </li>
              ))}
            </ul>

            <table className="hidden w-full text-[13.5px] md:table">
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
                  <th className="w-16 px-2 py-3 text-start font-medium">פריט</th>
                  <th className="px-3 py-3 text-start font-medium">ספר</th>
                  <th className="w-52 px-3 py-3 text-start font-medium">בדיקת פרטים</th>
                  <th className="w-32 px-3 py-3 text-start font-medium">צילום</th>
                  <th className="w-32 px-3 py-3 text-start font-medium">מסחרי</th>
                  <th className="w-28 pe-4 ps-2 py-3" aria-label="פעולות" />
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {visible.map((l) => (
                  <tr
                    key={l.id}
                    className={cn(
                      "group relative align-top transition-colors hover:bg-stone-2 [content-visibility:auto] [contain-intrinsic-size:auto_72px]",
                      selected.has(l.id) && "bg-accent-soft/50 hover:bg-accent-soft/70",
                    )}
                  >
                    <td className="relative z-10 ps-5 pe-1 py-3">
                      <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} aria-label={`בחירת פריט ${l.lotNumber}`} className="size-4 accent-[var(--color-ink)]" />
                    </td>
                    <td className="px-2 py-3">
                      <span className="num text-[15px] font-semibold">{l.lotNumber}</span>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex min-w-0 gap-3">
                        <span className="block size-12 shrink-0 overflow-hidden rounded-md bg-stone ring-1 ring-rule">
                          {l.thumbAssetId && <img src={`/api/assets/${l.thumbAssetId}/thumb`} alt="" loading="lazy" decoding="async" className="size-full object-cover" />}
                        </span>
                        <div className="min-w-0">
                          {/* stretched link: clicking anywhere on the row opens the book */}
                          <Link href={`/lots/${l.id}`} className="line-clamp-2 font-medium leading-snug text-ink after:absolute after:inset-0">
                            {l.title}
                          </Link>
                          {identLine(l) && <div className="truncate text-[12.5px] text-muted">{identLine(l)}</div>}
                          <div className="truncate text-[12px] text-muted">
                            {l.bookCount > 1 && (
                              <span className="me-2 inline-flex items-center gap-1 rounded-md bg-accent-soft px-1.5 py-0.5 text-[11.5px] font-semibold text-accent" title="לוט משולב: כמה ספרים נמכרים יחד">
                                <Layers className="size-3" aria-hidden />
                                <span className="num">{l.bookCount}</span> ספרים
                              </span>
                            )}
                            <span className="num font-mono text-[11.5px] text-ink-2">{l.bookCount > 1 ? l.books.map((b) => b.inventoryNumber).join(" · ") : l.inventoryNumber}</span>
                            {l.consignorName && <span> · {l.consignorName}</span>}
                            {l.locationLabel && <span> · {l.locationLabel}</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <ReviewCell review={l.review} />
                    </td>
                    <td className="px-3 py-3">
                      <LotStatusBadge status={l.status} />
                      <div
                        className="mt-0.5 text-[11.5px] text-muted"
                        title={PHOTO_CATEGORIES.filter((c) => l.counts[c]).map((c) => `${t.category[c]}: ${l.counts[c]}`).join(" · ") || "אין תמונות"}
                      >
                        <span className="num">{l.photoCount}</span> תמונות
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <CommercialStatusBadge status={l.commercialStatus} className={cn(l.assignmentStatus === "ENDED" && "opacity-70")} />
                    </td>
                    <td className="relative z-10 pe-4 ps-2 py-2.5">
                      <div className="flex items-center justify-end gap-1">{lotActions(l)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
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
          {perms.assign && selected.size >= 2 && (
            <Button size="sm" className="border-white/15 bg-white/8 text-paper shadow-none hover:bg-white/14" icon={<Layers />} onClick={() => setMergeOpen(true)}>
              איחוד ללוט
            </Button>
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

      <Dialog open={!!aiLot} onClose={() => setAiLot(null)} title={aiLot ? `ניתוח AI - לוט ${aiLot.lotNumber}` : ""} description="בחרו את הספר לניתוח. הניתוח הוא של הספר עצמו ונשמר אצלו; הוא לא משנה את התיאור המשותף של הלוט." width="md">
        <ul className="divide-y divide-rule rounded-lg border border-rule">
          {aiLot?.books.map((b, i) => (
            <li key={b.itemId} className="flex items-center gap-3 px-3.5 py-2.5 text-[13.5px]">
              <span className="num w-5 text-center font-semibold text-muted">{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{b.title}</span>
                <span className="num font-mono text-[11.5px] text-muted">{b.inventoryNumber}</span>
              </span>
              <AiAnalyzeButton itemId={b.itemId} inventoryNumber={b.inventoryNumber} initial={b.ai} />
            </li>
          ))}
        </ul>
        <div className="mt-5">
          <Button onClick={() => setAiLot(null)}>סגירה</Button>
        </div>
      </Dialog>
      <MergeLotsDialog
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        catalogId={catalogId}
        lots={lots.filter((l) => selected.has(l.id))}
        onDone={() => setSelected(new Set())}
      />
      <AddFromInventoryDialog open={pickerOpen} onClose={() => setPickerOpen(false)} catalogId={catalogId} catalogLabel={catalogLabel} />
      <RemoveLotsDialog catalogId={catalogId} ids={removeIds} lots={lots} onClose={() => setRemoveIds(null)} onDone={() => setSelected(new Set())} />
      <QuickBookDialog
        open={asking !== null}
        initialTitle={asking ?? ""}
        onClose={() => {
          setAsking(null);
          requestAnimationFrame(() => quickRef.current?.focus());
        }}
        onConfirm={quickCreate}
        hint={<>הספר ייווצר במלאי וישויך אוטומטית לקטלוג {catalogLabel}.</>}
        confirmLabel="הוספה לקטלוג"
      />
      <ConsignorPickDialog
        open={dupFor !== null}
        onClose={() => setDupFor(null)}
        heading="עותק פיזי נוסף"
        description={dupFor ? <>ייווצר ספר מלאי חדש עם הפרטים של פריט {dupFor.lotNumber} · {dupFor.title}. המפקיד של העותק החדש נבחר בנפרד.</> : undefined}
        confirmLabel="יצירת העותק"
        onConfirm={(c) => duplicate(dupFor!.id, c)}
      />
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
