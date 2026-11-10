"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Camera, Layers, MapPin, Plus, Search, Trash2, Unlink } from "lucide-react";
import type { ItemReviewStatus, PhysicalStatus } from "@avot/shared";
import { Button, IconButton } from "@/components/ui/button";
import { PhysicalStatusBadge, ReviewStatusBadge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/field";
import { Panel } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";

export interface LotBook {
  itemId: string;
  inventoryNumber: string;
  title: string;
  author: string | null;
  thumbAssetId: string | null;
  reviewStatus: ItemReviewStatus;
  physicalStatus: PhysicalStatus;
  locationLabel: string | null;
  photoCount: number;
}

interface Candidates {
  consignorId: string | null;
  lots: { lotId: string; lotNumber: number; item: { id: string; inventoryNumber: string; title: string; author: string | null; photoCount: number; primaryAssetId: string | null } }[];
  items: { id: string; inventoryNumber: string; title: string; author: string | null; photoCount: number; primaryAssetId: string | null }[];
}

/**
 * "הספרים בלוט": every book of the combined lot with its inventory number, main photo, review state and shelf, a link
 * to its inventory page, its order inside the lot and (while the lot is still being prepared) removal, addition and
 * dissolving. The server repeats every rule; the buttons only appear when the change is possible.
 */
export function BooksPanel({
  lotId,
  lotNumber,
  books,
  canChange,
  blockedReason,
  canCapture,
}: {
  lotId: string;
  lotNumber: number;
  books: LotBook[];
  /** the composition may change: the lot is active, not offered or sold, and the user may assign */
  canChange: boolean;
  /** why it may not (shown instead of the buttons) */
  blockedReason: string | null;
  canCapture: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [dissolving, setDissolving] = useState(false);
  const [removing, setRemoving] = useState<LotBook | null>(null);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.success(ok);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const move = (i: number, dir: -1 | 1) => {
    const ids = books.map((b) => b.itemId);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void run(() => api(`/api/lots/${lotId}/members`, { method: "PUT", json: { orderedItemIds: ids } }));
  };

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <Layers className="size-4 text-accent" aria-hidden />
          הספרים בלוט <span className="num text-muted">({books.length})</span>
        </span>
      }
      actions={
        canChange && (
          <span className="flex items-center gap-1.5">
            <Button size="sm" icon={<Plus />} onClick={() => setAdding(true)}>
              הוסף ספר ללוט
            </Button>
            <Button size="sm" variant="danger" icon={<Unlink />} onClick={() => setDissolving(true)}>
              פירוק הלוט
            </Button>
          </span>
        )
      }
    >
      <ol className="divide-y divide-rule">
        {books.map((b, i) => (
          <li key={b.itemId} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="num w-5 shrink-0 text-center text-[13px] font-semibold text-muted">{i + 1}</span>
            <span className="block size-14 shrink-0 overflow-hidden rounded-md bg-stone ring-1 ring-rule">
              {b.thumbAssetId && <img src={`/api/assets/${b.thumbAssetId}/thumb`} alt="" loading="lazy" className="size-full object-cover" />}
            </span>
            <div className="min-w-0 flex-1 basis-56">
              <Link href={`/inventory/${b.itemId}`} className="block truncate text-[14px] font-medium hover:underline" title="לדף המלאי של הספר">
                {b.title}
              </Link>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted">
                <Link href={`/inventory/${b.itemId}`} className="num font-mono text-[11.5px] text-ink-2 hover:underline">
                  {b.inventoryNumber}
                </Link>
                {b.author && <span className="truncate">{b.author}</span>}
                <span className="inline-flex items-center gap-1">
                  <MapPin className="size-3" aria-hidden />
                  {b.locationLabel ?? "ללא מיקום"}
                </span>
                <span>
                  <span className="num">{b.photoCount}</span> תמונות
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <ReviewStatusBadge status={b.reviewStatus} />
                <PhysicalStatusBadge status={b.physicalStatus} />
              </div>
            </div>
            <div className="flex items-center gap-1">
              {canCapture && (
                <Link href={`/capture/${b.itemId}`} className="inline-flex h-7.5 items-center gap-1.5 rounded-md border border-rule-strong bg-paper px-2.5 text-[13px] shadow-card hover:bg-stone-2" title="צילום הספר">
                  <Camera className="size-3.5 text-accent" aria-hidden />
                  צילום
                </Link>
              )}
              {canChange && (
                <>
                  <IconButton size="sm" label="העברה למעלה" disabled={busy || i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp />
                  </IconButton>
                  <IconButton size="sm" label="העברה למטה" disabled={busy || i === books.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown />
                  </IconButton>
                  <IconButton size="sm" label={`הסרת ${b.title} מהלוט`} disabled={busy || books.length < 2} onClick={() => setRemoving(b)}>
                    <Trash2 />
                  </IconButton>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
      {!canChange && blockedReason && <p className="border-t border-rule px-4 py-3 text-[12.5px] text-muted">{blockedReason}</p>}

      <AddBookDialog open={adding} onClose={() => setAdding(false)} lotId={lotId} />

      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title="הסרת ספר מהלוט"
        description={removing ? `הספר ${removing.inventoryNumber} · ${removing.title} יחזור להיות פריט נפרד בקטלוג, במספר הפריט ההיסטורי שלו אם הוא פנוי ואחרת במספר חדש. הספר, התמונות והניתוחים שלו לא משתנים.` : undefined}
        width="sm"
      >
        <p className="text-[13px] leading-relaxed text-muted">התיאור המשותף של הלוט יישמר, אך יסומן כ״דורש עדכון״ כי הוא נכתב להרכב קודם.</p>
        <div className="mt-5 flex gap-2">
          <Button
            variant="danger"
            loading={busy}
            onClick={() =>
              removing &&
              run(async () => {
                const r = await api<{ newLot: { lotNumber: number; restored: boolean } }>(`/api/lots/${lotId}/members/${removing.itemId}`, { method: "DELETE" });
                toast.success(`הספר הוסר מהלוט: פריט ${r.newLot.lotNumber}${r.newLot.restored ? " (המספר ההיסטורי)" : " (מספר חדש)"}`);
                setRemoving(null);
              })
            }
          >
            הסרה מהלוט
          </Button>
          <Button onClick={() => setRemoving(null)}>ביטול</Button>
        </div>
      </Dialog>

      <Dialog
        open={dissolving}
        onClose={() => setDissolving(false)}
        title={`פירוק לוט ${lotNumber}`}
        description="כל ספר יחזור להיות פריט מכירה נפרד באותו קטלוג. הספרים נשארים במלאי בדיוק כפי שהיו, התמונות והניתוחים שלהם לא משתנים, והתיאור המשותף נשמר בהיסטוריית הלוט."
        width="sm"
      >
        <ul className="mb-1 list-disc space-y-1 ps-5 text-[13px] text-ink-2">
          <li>מספרי הפריטים ההיסטוריים יחזרו לספרים שהגיעו מהם; ספר שאין לו מספר פנוי יקבל מספר חדש.</li>
          <li>מידע האיחוד נשמר ואינו נמחק.</li>
        </ul>
        <div className="mt-5 flex gap-2">
          <Button
            variant="danger"
            loading={busy}
            onClick={() =>
              run(async () => {
                await api(`/api/lots/${lotId}/dissolve`, { method: "POST" });
                toast.success("הלוט פורק: כל ספר חזר להיות פריט נפרד");
                setDissolving(false);
              })
            }
          >
            פירוק הלוט
          </Button>
          <Button onClick={() => setDissolving(false)}>ביטול</Button>
        </div>
      </Dialog>
    </Panel>
  );
}

/** "הוסף ספר ללוט": books of the same catalog and the same consignor (their own lots join this one) and unassigned books. */
function AddBookDialog({ open, onClose, lotId }: { open: boolean; onClose: () => void; lotId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [data, setData] = useState<Candidates | null>(null);
  const [picked, setPicked] = useState<{ lots: Set<string>; items: Set<string> }>({ lots: new Set(), items: new Set() });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<Candidates>(`/api/lots/${lotId}/members?q=${encodeURIComponent(q.trim())}`));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, [lotId, q, toast]);

  useEffect(() => {
    if (!open) return;
    setPicked({ lots: new Set(), items: new Set() });
    const id = setTimeout(() => void load(), 250);
    return () => clearTimeout(id);
  }, [open, load]);

  const flip = (kind: "lots" | "items", id: string) =>
    setPicked((p) => {
      const s = new Set(p[kind]);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return { ...p, [kind]: s };
    });
  const count = picked.lots.size + picked.items.size;

  async function add() {
    setBusy(true);
    try {
      await api(`/api/lots/${lotId}/members`, { method: "POST", json: { lotIds: [...picked.lots], itemIds: [...picked.items] } });
      toast.success(`נוספו ${count} ספרים ללוט`, { detail: "התיאור המשותף סומן כדורש עדכון" });
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const row = (kind: "lots" | "items", id: string, title: string, num: string, extra?: string) => (
    <label key={`${kind}-${id}`} className={cn("flex cursor-pointer items-center gap-3 px-3.5 py-2.5 text-[13.5px] hover:bg-stone-2", picked[kind].has(id) && "bg-accent-soft/50")}>
      <input type="checkbox" checked={picked[kind].has(id)} onChange={() => flip(kind, id)} className="size-4 accent-[var(--color-ink)]" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
        <span className="block truncate text-[12.5px] text-muted">
          <span className="num font-mono text-[11.5px]">{num}</span>
          {extra && <span> · {extra}</span>}
        </span>
      </span>
    </label>
  );

  return (
    <Dialog open={open} onClose={onClose} title="הוסף ספר ללוט" description="מוצגים ספרים מאותו קטלוג ומאותו מפקיד, וספרים שאינם משויכים לקטלוג פעיל." width="lg">
      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש: שם, מחבר או מספר מלאי" className="ps-9" aria-label="חיפוש ספר להוספה" />
      </div>
      <div className="mt-3 max-h-80 overflow-y-auto rounded-lg border border-rule">
        {!data ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted">טוען…</p>
        ) : !data.consignorId ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted">לא נמצא מפקיד לספרי הלוט.</p>
        ) : data.lots.length + data.items.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted">אין ספרים מתאימים של אותו מפקיד.</p>
        ) : (
          <div className="divide-y divide-rule">
            {data.lots.length > 0 && <div className="bg-stone px-3.5 py-1.5 text-[12px] font-medium text-muted">פריטים באותו קטלוג (יאוחדו ללוט)</div>}
            {data.lots.map((l) => row("lots", l.lotId, l.item.title, l.item.inventoryNumber, `פריט ${l.lotNumber}`))}
            {data.items.length > 0 && <div className="bg-stone px-3.5 py-1.5 text-[12px] font-medium text-muted">ספרים שאינם בקטלוג פעיל</div>}
            {data.items.map((i) => row("items", i.id, i.title, i.inventoryNumber, i.author ?? undefined))}
          </div>
        )}
      </div>
      <div className="mt-5 flex gap-2">
        <Button variant="primary" loading={busy} disabled={count === 0} onClick={add}>
          הוספת {count || ""} ספרים ללוט
        </Button>
        <Button onClick={onClose}>ביטול</Button>
      </div>
    </Dialog>
  );
}
