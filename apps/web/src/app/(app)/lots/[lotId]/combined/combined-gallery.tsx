"use client";

import { useCallback, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Download, Eye, EyeOff, RotateCcw, Star } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { Panel } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { ExportDialog, type ExportScope } from "@/components/export-dialog";
import { ImageViewer, assetViewerDetails, type ViewerItem } from "@/components/image-viewer";
import { downloadOptions } from "@/lib/asset-versions";
import { t } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { AssetDto } from "@/server/services/asset-dto";

export type GalleryAsset = AssetDto & { hidden: boolean; book: { id: string; inventoryNumber: string; title: string; index: number } | null };

/**
 * The shared gallery of a combined lot: every book's photos in one list, each clearly marked with its book. The
 * photos stay owned by their books - this screen only chooses how the LOT shows them: the order, the main photo and
 * what is hidden from the catalog view. Selection and the two download buttons use the normal export (the lot
 * export contains every book's photos in the order set here, hidden ones left out).
 */
export function CombinedGallery({
  lotId,
  lotNumber,
  initial,
  books,
  canEdit,
  canDownload,
}: {
  lotId: string;
  lotNumber: number;
  initial: GalleryAsset[];
  books: { itemId: string; inventoryNumber: string; title: string }[];
  canEdit: boolean;
  canDownload: boolean;
}) {
  const toast = useToast();
  const [assets, setAssets] = useState<GalleryAsset[]>(initial);
  const [filter, setFilter] = useState<string>("ALL");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  const [exporting, setExporting] = useState<ExportScope | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const r = await api<{ assets: GalleryAsset[] }>(`/api/lots/${lotId}/gallery`);
    setAssets(r.assets);
  }, [lotId]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
      await reload().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const visibleAll = useMemo(() => assets.filter((a) => !a.hidden), [assets]);
  const shown = useMemo(() => assets.filter((a) => filter === "ALL" || a.book?.id === filter), [assets, filter]);
  const hiddenCount = assets.length - visibleAll.length;
  const canReorder = canEdit && filter === "ALL";

  /** Saves the order of the visible photos with `id` moved to the position of `before` (or by one step). */
  function reorder(order: string[]) {
    void run(() => api(`/api/lots/${lotId}/gallery`, { method: "PUT", json: { orderedAssetIds: order } }));
  }
  function step(id: string, dir: -1 | 1) {
    const ids = visibleAll.map((a) => a.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    reorder(ids);
  }
  function drop(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const ids = visibleAll.map((a) => a.id).filter((x) => x !== dragId);
    const at = ids.indexOf(targetId);
    ids.splice(at < 0 ? ids.length : at, 0, dragId);
    setDragId(null);
    reorder(ids);
  }
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const viewerItems: ViewerItem[] = shown
    .filter((a) => !a.hidden)
    .map((a) => ({
      key: a.id,
      title: `${a.book?.inventoryNumber ?? ""} · ${t.category[a.category]}`,
      src: a.previewUrl ?? a.thumbUrl,
      fullSrc: a.processedUrl,
      originalSrc: `/api/assets/${a.id}/original`,
      download: canDownload ? downloadOptions(a) : null,
      hasProcessed: !!a.processed,
      rotation: a.rotation,
      ...assetViewerDetails(a),
    }));

  return (
    <Panel
      title={
        <span>
          גלריה משותפת <span className="num text-muted">({visibleAll.length})</span>
          {hiddenCount > 0 && <span className="ms-2 text-[12px] font-normal text-muted">{hiddenCount} מוסתרות מהקטלוג</span>}
        </span>
      }
      actions={
        canDownload && (
          <span className="flex items-center gap-1.5">
            {selected.size > 0 && (
              <Button size="sm" variant="primary" icon={<Download />} onClick={() => setExporting({ scope: "selection", assetIds: [...selected] })}>
                ייצוא {selected.size} נבחרות
              </Button>
            )}
            <Button size="sm" icon={<Download />} onClick={() => setExporting({ scope: "lot", lotId })} disabled={visibleAll.length === 0}>
              הורדת כל תמונות הלוט
            </Button>
          </span>
        )
      }
    >
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="סינון לפי ספר">
          <Chip active={filter === "ALL"} onClick={() => setFilter("ALL")}>
            כל הספרים <span className="num">{assets.length}</span>
          </Chip>
          {books.map((b, i) => (
            <Chip key={b.itemId} active={filter === b.itemId} onClick={() => setFilter(b.itemId)} title={b.title}>
              <span className="num">{i + 1}</span> · <span className="num font-mono text-[11.5px]">{b.inventoryNumber}</span>{" "}
              <span className="num text-muted">{assets.filter((a) => a.book?.id === b.itemId).length}</span>
            </Chip>
          ))}
          {canEdit && (
            <Button size="sm" variant="ghost" className="ms-auto" icon={<RotateCcw />} disabled={busy} onClick={() => run(() => api(`/api/lots/${lotId}/display`, { method: "POST", json: { reset: true } }))}>
              איפוס תצוגה
            </Button>
          )}
        </div>
        {filter !== "ALL" && canEdit && <p className="text-[12px] text-muted">שינוי הסדר זמין בתצוגת כל הספרים.</p>}

        {shown.length === 0 ? (
          <p className="rounded-lg bg-stone px-4 py-8 text-center text-[13px] text-muted">אין תמונות לספרי הלוט עדיין. צלמו כל ספר מהרשימה למעלה.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
            {shown.map((a) => {
              const pos = visibleAll.findIndex((x) => x.id === a.id);
              return (
                <li
                  key={a.id}
                  draggable={canReorder && !a.hidden}
                  onDragStart={() => setDragId(a.id)}
                  onDragOver={(e) => canReorder && e.preventDefault()}
                  onDrop={() => canReorder && drop(a.id)}
                  className={cn("group relative overflow-hidden rounded-lg bg-stone ring-1 ring-rule", a.isPrimary && "ring-2 ring-accent", a.hidden && "opacity-45", dragId === a.id && "opacity-50")}
                >
                  <button
                    type="button"
                    className="block aspect-[4/3] w-full bg-stone-2"
                    onClick={() => {
                      const idx = viewerItems.findIndex((v) => v.key === a.id);
                      if (idx >= 0) setViewer(idx);
                    }}
                    aria-label={`צפייה בתמונה: ${a.book?.inventoryNumber ?? ""} ${t.category[a.category]}`}
                  >
                    {a.thumbUrl && <img src={a.thumbUrl} alt="" loading="lazy" className="size-full object-contain" style={{ transform: `rotate(${a.rotation}deg)` }} />}
                  </button>
                  {canDownload && (
                    <input
                      type="checkbox"
                      checked={selected.has(a.id)}
                      onChange={() => toggle(a.id)}
                      aria-label="בחירה לייצוא"
                      className="absolute start-2 top-2 size-4 accent-[var(--color-ink)]"
                    />
                  )}
                  {a.isPrimary && (
                    <span className="absolute end-2 top-2 inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-[11px] font-semibold text-white">
                      <Star className="size-3 fill-white" aria-hidden /> ראשית
                    </span>
                  )}
                  <div className="flex items-center gap-1 border-t border-rule bg-paper px-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-[11.5px]" title={a.book?.title}>
                      <span className="num font-semibold">{a.book?.index}</span> · <span className="num font-mono">{a.book?.inventoryNumber}</span>
                      <span className="text-muted"> · {t.category[a.category]}</span>
                    </span>
                    {canEdit && (
                      <span className="flex shrink-0 items-center">
                        {canReorder && !a.hidden && (
                          <>
                            <IconButton size="sm" label="קדימה" disabled={busy || pos <= 0} onClick={() => step(a.id, -1)}>
                              <ArrowRight />
                            </IconButton>
                            <IconButton size="sm" label="אחורה" disabled={busy || pos < 0 || pos === visibleAll.length - 1} onClick={() => step(a.id, 1)}>
                              <ArrowLeft />
                            </IconButton>
                          </>
                        )}
                        {!a.hidden && (
                          <IconButton size="sm" label="תמונה ראשית של הלוט" disabled={busy || a.isPrimary} onClick={() => run(() => api(`/api/assets/${a.id}/primary?lotId=${lotId}`, { method: "POST" }))}>
                            <Star className={a.isPrimary ? "fill-accent text-accent" : ""} />
                          </IconButton>
                        )}
                        <IconButton
                          size="sm"
                          label={a.hidden ? "הצגה בקטלוג" : "הסתרה מתצוגת הקטלוג"}
                          disabled={busy}
                          onClick={() => run(() => api(`/api/lots/${lotId}/display`, { method: "POST", json: { assetId: a.id, hidden: !a.hidden } }))}
                        >
                          {a.hidden ? <Eye /> : <EyeOff />}
                        </IconButton>
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-[12px] text-muted">התמונות נשארות שייכות לספרים שלהם; הסדר, ההסתרה והתמונה הראשית חלים על לוט {lotNumber} בלבד.</p>
      </div>

      {viewer !== null && viewerItems.length > 0 && <ImageViewer items={viewerItems} index={Math.min(viewer, viewerItems.length - 1)} onIndex={setViewer} onClose={() => setViewer(null)} />}
      {exporting && <ExportDialog open onClose={() => setExporting(null)} request={exporting} title={exporting.scope === "lot" ? `תמונות לוט ${lotNumber}` : "ייצוא תמונות נבחרות"} />}
    </Panel>
  );
}

function Chip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn("rounded-full border px-3 py-1 text-[12.5px] transition-colors", active ? "border-ink bg-ink text-paper" : "border-rule-strong bg-paper text-ink-2 hover:bg-stone-2")}
    >
      {children}
    </button>
  );
}
