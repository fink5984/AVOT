"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  ArrowRightLeft,
  Camera,
  Check,
  CircleSlash,
  Columns2,
  Download,
  FolderInput,
  GripVertical,
  ImageOff,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  RotateCw,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { PHOTO_CATEGORIES, type PhotoCategory } from "@avot/shared";
import { Button, ButtonLink, IconButton } from "@/components/ui/button";
import { UploadBadge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { Menu } from "@/components/ui/menu";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { PROCESSED_NOT_READY, downloadOptions, processedReady, startDownload } from "@/lib/asset-versions";
import { ExportDialog } from "@/components/export-dialog";
import { ImageViewer, assetViewerDetails, type ViewerItem } from "@/components/image-viewer";
import { fmt, t } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { outbox, sha256Hex, storageHealth } from "@/lib/capture/outbox";
import { uploader } from "@/lib/capture/uploader";
import type { AssetDto } from "@/server/services/asset-dto";

type Tab = PhotoCategory | "ALL";

interface CategoryProgress {
  category: PhotoCategory;
  count: number;
  required: boolean;
  min: number;
  satisfied: boolean;
  needsReshoot: boolean;
  note: string | null;
}

const IMPORT_ACCEPT = "image/jpeg,image/png,image/webp,image/tiff,.cr3,.cr2,.dng";

function cropStyle(a: AssetDto): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (a.rotation) style.transform = `rotate(${a.rotation}deg)`;
  if (a.crop) {
    const { x, y, w, h } = a.crop;
    style.clipPath = `inset(${y * 100}% ${(1 - x - w) * 100}% ${(1 - y - h) * 100}% ${x * 100}%)`;
  }
  return style;
}

export function Gallery({
  lot,
  initialAssets,
  initialCategory,
  progress,
  siblings,
  userId,
  perms,
}: {
  /** a catalog lot, or an inventory book (id = inventory id, `name` = its inventory number) */
  lot: { id: string; lotNumber: number; catalogId: string; catalogNumber: string; title: string; name?: string };
  initialAssets: AssetDto[];
  initialCategory: Tab;
  progress: CategoryProgress[];
  siblings: { id: string; lotNumber: number; title: string }[];
  userId: string;
  perms: { organize: boolean; remove: boolean; download: boolean; capture: boolean; mark: boolean };
}) {
  const router = useRouter();
  const toast = useToast();
  const [assets, setAssets] = useState(initialAssets);
  const [tab, setTab] = useState<Tab>(initialCategory);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewer, setViewer] = useState<number | null>(null);
  const [compare, setCompare] = useState<[AssetDto, AssetDto] | null>(null);
  const [edit, setEdit] = useState<AssetDto | null>(null);
  const [move, setMove] = useState<string[] | null>(null);
  const [exportReq, setExportReq] = useState<{ title: string; req: Parameters<typeof ExportDialog>[0]["request"] } | null>(null);
  const [importing, setImporting] = useState<{ done: number; total: number } | null>(null);
  const [lastClicked, setLastClicked] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);

  const refresh = useCallback(async () => {
    const r = await api<{ assets: AssetDto[] }>(`/api/lots/${lot.id}/assets`);
    setAssets(r.assets);
    setSelected((s) => new Set([...s].filter((id) => r.assets.some((a) => a.id === id))));
    router.refresh();
  }, [lot.id, router]);

  const visible = useMemo(() => (tab === "ALL" ? assets : assets.filter((a) => a.category === tab)), [assets, tab]);
  const counts = useMemo(() => Object.fromEntries(PHOTO_CATEGORIES.map((c) => [c, assets.filter((a) => a.category === c).length])), [assets]);
  const selectedList = visible.filter((a) => selected.has(a.id));
  const current = tab === "ALL" ? null : progress.find((p) => p.category === tab) ?? null;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  function changeTab(v: Tab) {
    setTab(v);
    setSelected(new Set());
    const url = new URL(window.location.href);
    if (v === "ALL") url.searchParams.delete("category");
    else url.searchParams.set("category", v);
    window.history.replaceState(null, "", url.toString());
  }

  async function onDragEnd(e: DragEndEvent) {
    if (tab === "ALL" || !e.over || e.active.id === e.over.id) return;
    const ids = visible.map((a) => a.id);
    const next = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    const before = assets;
    setAssets((all) => {
      const others = all.filter((a) => a.category !== tab);
      const reordered = next.map((id, i) => ({ ...all.find((a) => a.id === id)!, sortOrder: i + 1 }));
      return [...others, ...reordered].sort((a, b) => (a.category === b.category ? a.sortOrder - b.sortOrder : PHOTO_CATEGORIES.indexOf(a.category) - PHOTO_CATEGORIES.indexOf(b.category)));
    });
    try {
      await api("/api/assets/reorder", { method: "POST", json: { lotId: lot.id, category: tab, orderedIds: next } });
    } catch (err) {
      setAssets(before);
      toast.error(errorMessage(err));
    }
  }

  function toggle(id: string, shift: boolean) {
    setSelected((s) => {
      const n = new Set(s);
      if (shift && lastClicked) {
        const ids = visible.map((a) => a.id);
        const [a, b] = [ids.indexOf(lastClicked), ids.indexOf(id)].sort((x, y) => x - y);
        for (const x of ids.slice(a, b! + 1)) n.add(x);
      } else if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
    setLastClicked(id);
  }

  async function bulk(path: string, json: unknown, ok: string) {
    try {
      await api(path, { method: "POST", json });
      toast.success(ok);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function removeSelected(ids: string[]) {
    try {
      await api("/api/assets/delete", { method: "POST", json: { assetIds: ids } });
      setSelected(new Set());
      await refresh();
      toast.success(`${ids.length} תמונות הועברו לסל המחזור`, {
        action: { label: "ביטול", onClick: () => void bulk("/api/assets/restore", { assetIds: ids }, "התמונות שוחזרו") },
      });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function rotate(a: AssetDto, delta: number) {
    const rotation = (((a.rotation + delta) % 360) + 360) % 360;
    setAssets((all) => all.map((x) => (x.id === a.id ? { ...x, rotation } : x)));
    try {
      await api(`/api/assets/${a.id}`, { method: "PATCH", json: { rotation } });
    } catch (err) {
      toast.error(errorMessage(err));
      await refresh();
    }
  }

  async function markCategory(category: PhotoCategory, body: Record<string, unknown>, okMsg: string) {
    try {
      await api(`/api/lots/${lot.id}/categories/${category}`, { method: "PATCH", json: body });
      toast.success(okMsg);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  /** Import existing image files through the same durable outbox + verified upload as captures. */
  async function importFiles(files: FileList | null, category: PhotoCategory) {
    if (!files?.length) return;
    const images = [...files].filter((f) => /^image\/(jpeg|png|webp|tiff)$/.test(f.type) || /\.(cr3|cr2|dng)$/i.test(f.name));
    if (!images.length) {
      toast.warning("לא נמצאו קובצי תמונה נתמכים (JPEG, PNG, WebP, TIFF, CR3, CR2, DNG)");
      return;
    }
    const health = await storageHealth();
    const total = images.reduce((s, f) => s + f.size, 0);
    if (health.freeBytes !== null && health.freeBytes < total * 1.2) {
      toast.error("אין מספיק מקום באחסון הדפדפן לייבוא זה", { detail: `נדרש ${fmt.bytes(total)}, פנוי ${fmt.bytes(health.freeBytes)}` });
      return;
    }
    images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    setImporting({ done: 0, total: images.length });
    let i = 0;
    for (const f of images) {
      const isRaw = /\.(cr3|cr2|dng)$/i.test(f.name);
      let width: number | undefined;
      let height: number | undefined;
      if (!isRaw) {
        try {
          const bmp = await createImageBitmap(f);
          width = bmp.width;
          height = bmp.height;
          bmp.close();
        } catch {
          toast.warning(`הקובץ ${f.name} פגום או אינו תמונה — דולג`);
          continue;
        }
      }
      const now = Date.now();
      await outbox.put({
        captureId: crypto.randomUUID(),
        userId,
        lotId: lot.id,
        catalogId: lot.catalogId,
        category,
        lotLabel: `${lot.catalogNumber}/${lot.lotNumber}`,
        source: "IMPORT",
        capturedAt: new Date(f.lastModified || now).toISOString(),
        exif: { importedFrom: f.name },
        files: [
          {
            role: isRaw ? "RAW" : "PRIMARY",
            blob: f,
            mimeType: f.type || (isRaw ? "image/x-canon-cr3" : "application/octet-stream"),
            filename: f.name,
            sizeBytes: f.size,
            sha256: await sha256Hex(f),
            width,
            height,
          },
        ],
        stage: "SAVED_LOCAL",
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: now + i,
      });
      setImporting({ done: ++i, total: images.length });
    }
    uploader.kick();
    setImporting(null);
    toast.success(`${i} קבצים נשמרו לתור ההעלאה`, { detail: "הם יופיעו כאן לאחר אימות בשרת." });
    const unsub = uploader.subscribe((e) => e.stage === "VERIFIED" && void refresh());
    setTimeout(unsub, 10 * 60 * 1000);
  }

  const viewerItems: ViewerItem[] = visible.map((a) => {
    const d = assetViewerDetails(a);
    return {
      key: a.id,
      title: `${t.category[a.category]} · ${a.displayName ?? `צילום ${a.sequence}`}`,
      src: a.previewUrl,
      fullSrc: a.processedUrl ?? (a.processed ? a.previewUrl : `/api/assets/${a.id}/original`),
      originalSrc: `/api/assets/${a.id}/original`,
      download: perms.download ? downloadOptions(a) : null,
      hasProcessed: !!a.processed,
      rotation: a.rotation,
      details: d.details,
      warnings: d.warnings,
    };
  });

  const canDrop = perms.capture && tab !== "ALL";

  return (
    <section className="card min-w-0">
      <div className="px-2 sm:px-3">
        <Tabs<Tab>
          value={tab}
          onChange={changeTab}
          label="קטגוריות צילום"
          items={[
            { value: "ALL", label: "כל התמונות", count: assets.length },
            ...PHOTO_CATEGORIES.map((c) => {
              const p = progress.find((x) => x.category === c);
              return {
                value: c as Tab,
                label: t.category[c],
                count: counts[c],
                adornment: p?.needsReshoot ? (
                  <span className="size-1.5 rounded-full bg-danger" title="דורש צילום חוזר" />
                ) : p && p.required && p.satisfied ? (
                  <Check className="size-3.5 text-green" strokeWidth={3} aria-label="עומד בדרישה" />
                ) : p && p.required ? (
                  <span className="size-1.5 rounded-full bg-warn" title={`נדרשות ${p.min}`} />
                ) : null,
              };
            }),
          ]}
        />
      </div>

      {/* context bar: what this category needs + the actions that belong to it */}
      <div className="flex flex-wrap items-center gap-2 border-b border-rule px-4 py-3 sm:px-5">
        {current ? (
          <div className="flex min-w-0 items-center gap-2 text-[13px]">
            {current.needsReshoot ? (
              <span className="font-medium text-danger">דורש צילום חוזר{current.note ? `: ${current.note}` : ""}</span>
            ) : !current.required ? (
              <span className="text-muted">קטגוריה זו סומנה כלא נדרשת לספר זה</span>
            ) : current.satisfied ? (
              <span className="flex items-center gap-1 text-green">
                <Check className="size-4" /> עומד בדרישה · <span className="num">{current.count}/{current.min}</span>
              </span>
            ) : (
              <span className="text-warn">
                צולמו <span className="num">{current.count}</span> מתוך <span className="num">{current.min}</span> נדרשות
              </span>
            )}
          </div>
        ) : (
          <span className="text-[13px] text-muted">
            <span className="num">{assets.length}</span> תמונות ב־<span className="num">{PHOTO_CATEGORIES.filter((c) => counts[c]).length}</span> קטגוריות
          </span>
        )}

        <div className="ms-auto flex flex-wrap items-center gap-1.5">
          {perms.download && visible.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Download />}
              onClick={() =>
                setExportReq(
                  tab === "ALL"
                    ? { title: `הורדת כל תמונות ${lot.name ?? `פריט ${lot.lotNumber}`}`, req: { scope: "lot", lotId: lot.id } }
                    : { title: `הורדת ${t.category[tab]} — ${lot.name ?? `פריט ${lot.lotNumber}`}`, req: { scope: "category", lotId: lot.id, category: tab } },
                )
              }
            >
              {tab === "ALL" ? "הורדת הספר (ZIP)" : "הורדת הקטגוריה (ZIP)"}
            </Button>
          )}
          {perms.capture && tab !== "ALL" && (
            <label className="inline-flex h-7.5 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-stone hover:text-ink">
              <FolderInput className="size-3.5" />
              ייבוא מהמחשב
              <input type="file" multiple accept={IMPORT_ACCEPT} className="sr-only" onChange={(e) => void importFiles(e.target.files, tab)} />
            </label>
          )}
          {perms.mark && current && (
            <CategoryMenu
              progress={current}
              onReshoot={(note) => markCategory(current.category, { needsReshoot: true, note }, "סומן לצילום חוזר")}
              onClearReshoot={() => markCategory(current.category, { needsReshoot: false }, "הסימון הוסר")}
              onToggleRequired={() =>
                markCategory(current.category, { notRequired: current.required }, current.required ? "הקטגוריה סומנה כלא נדרשת" : "הקטגוריה סומנה כנדרשת")
              }
            />
          )}
          {perms.capture && tab !== "ALL" && (
            <ButtonLink href={`/capture/${lot.id}?category=${tab}`} size="sm" variant="primary" icon={<Camera />}>
              צילום {t.categoryShort[tab]}
            </ButtonLink>
          )}
        </div>
      </div>

      {importing && (
        <p className="mx-5 mt-4 rounded-md bg-info-soft px-3 py-2 text-[13px] text-info" role="status">
          שומר לתור ההעלאה… <span className="num">{importing.done}/{importing.total}</span>
        </p>
      )}

      <div
        className={cn("relative p-4 sm:p-5", dropping && "bg-accent-soft/40")}
        onDragOver={(e) => {
          if (!canDrop || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
        }}
        onDrop={(e) => {
          if (!canDrop) return;
          e.preventDefault();
          setDropping(false);
          void importFiles(e.dataTransfer.files, tab);
        }}
      >
        {dropping && (
          <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-accent/60 bg-paper/80 text-[14px] font-medium text-accent-2">
            <Upload className="me-2 size-5" /> שחררו כאן כדי לייבא ל{tab !== "ALL" ? t.category[tab] : ""}
          </div>
        )}
        {visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-rule px-6 py-14 text-center">
            <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-stone text-muted">
              <ImageOff className="size-5.5 stroke-[1.6]" />
            </div>
            <h3 className="text-[15px] font-semibold">{tab === "ALL" ? "אין עדיין תמונות לספר זה" : `אין תמונות ב${t.category[tab]}`}</h3>
            <p className="mt-1.5 max-w-sm text-[13.5px] text-muted">
              {tab === "ALL" ? "פתחו את מסך הצילום כדי להתחיל." : "צלמו עכשיו, או גררו לכאן קבצים מהמחשב."}
            </p>
            {perms.capture && (
              <ButtonLink href={`/capture/${lot.id}${tab !== "ALL" ? `?category=${tab}` : ""}`} variant="capture" icon={<Camera />} className="mt-5">
                {tab === "ALL" ? "התחלת צילום" : `צילום ${t.category[tab]}`}
              </ButtonLink>
            )}
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={visible.map((a) => a.id)} strategy={rectSortingStrategy}>
              <ul className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
                {visible.map((a, i) => (
                  <Tile
                    key={a.id}
                    asset={a}
                    index={i}
                    showCategory={tab === "ALL"}
                    sortable={tab !== "ALL" && perms.organize}
                    selected={selected.has(a.id)}
                    selecting={selected.size > 0}
                    onToggle={(shift) => toggle(a.id, shift)}
                    onOpen={() => setViewer(i)}
                    onEdit={() => setEdit(a)}
                    onRotate={(d) => rotate(a, d)}
                    onPrimary={() => bulk(`/api/assets/${a.id}/primary`, {}, "התמונה הוגדרה כתמונה ראשית")}
                    perms={perms}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
        {tab !== "ALL" && perms.organize && visible.length > 1 && (
          <p className="mt-4 text-[12.5px] text-faint">גררו תמונה כדי לשנות את הסדר · Shift+לחיצה לבחירת טווח</p>
        )}
      </div>

      {selectedList.length > 0 && (
        <div className="animate-pop fixed inset-x-0 bottom-6 z-30 mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-wrap items-center gap-1.5 rounded-xl bg-ink py-2 pe-2 ps-4 text-[13.5px] text-paper shadow-pop ring-1 ring-white/10">
          <span className="me-2">
            נבחרו <span className="num font-semibold">{selectedList.length}</span>
          </span>
          {selectedList.length === 2 && (
            <BarButton icon={<Columns2 />} onClick={() => setCompare([selectedList[0]!, selectedList[1]!])}>
              השוואה
            </BarButton>
          )}
          {perms.download && (
            <BarButton icon={<Download />} onClick={() => setExportReq({ title: `הורדת ${selectedList.length} תמונות`, req: { scope: "selection", assetIds: selectedList.map((a) => a.id) } })}>
              הורדה
            </BarButton>
          )}
          {perms.organize && (
            <BarButton icon={<ArrowRightLeft />} onClick={() => setMove(selectedList.map((a) => a.id))}>
              העברה
            </BarButton>
          )}
          {perms.remove && (
            <BarButton icon={<Trash2 />} onClick={() => removeSelected(selectedList.map((a) => a.id))}>
              לסל המחזור
            </BarButton>
          )}
          <IconButton label="ניקוי בחירה" size="sm" className="text-white/60 hover:bg-white/10 hover:text-white" onClick={() => setSelected(new Set())}>
            <X />
          </IconButton>
        </div>
      )}

      {viewer !== null && <ImageViewer items={viewerItems} index={viewer} onIndex={setViewer} onClose={() => setViewer(null)} />}
      {compare && <CompareView pair={compare} onClose={() => setCompare(null)} />}
      {edit && <EditAssetDialog asset={edit} onClose={() => setEdit(null)} onSaved={refresh} canRemove={perms.remove} />}
      <MoveDialog
        ids={move}
        currentLot={lot}
        siblings={siblings}
        onClose={() => setMove(null)}
        onDone={async () => {
          setMove(null);
          setSelected(new Set());
          await refresh();
        }}
      />
      {exportReq && (
        <ExportDialog
          open
          onClose={() => setExportReq(null)}
          title={exportReq.title}
          request={exportReq.req}
          photos={(() => {
            const r = exportReq.req;
            const scoped = r.scope === "selection" ? assets.filter((a) => r.assetIds.includes(a.id)) : r.scope === "category" ? assets.filter((a) => a.category === r.category) : assets;
            return { total: scoped.length, processedReady: scoped.filter(processedReady).length };
          })()}
        />
      )}
    </section>
  );
}

function BarButton({ icon, onClick, children }: { icon: React.ReactNode; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button size="sm" variant="ghost" icon={icon} onClick={onClick} className="text-paper hover:bg-white/12 hover:text-white">
      {children}
    </Button>
  );
}

function CategoryMenu({
  progress: p,
  onReshoot,
  onClearReshoot,
  onToggleRequired,
}: {
  progress: CategoryProgress;
  onReshoot: (note: string | null) => void;
  onClearReshoot: () => void;
  onToggleRequired: () => void;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(p.note ?? "");
  return (
    <>
      <Menu
        trigger={(props) => (
          <IconButton label={`אפשרויות ל${t.category[p.category]}`} size="sm" {...props}>
            <MoreHorizontal />
          </IconButton>
        )}
        items={[
          p.needsReshoot
            ? { label: "ביטול סימון צילום חוזר", icon: <RotateCcw />, onSelect: onClearReshoot }
            : { label: "סימון לצילום חוזר", icon: <RotateCcw />, onSelect: () => setNoteOpen(true) },
          { label: p.required ? "לא נדרש לספר זה" : "סימון כנדרש", icon: <CircleSlash />, onSelect: onToggleRequired },
        ]}
      />
      <Dialog open={noteOpen} onClose={() => setNoteOpen(false)} title={`צילום חוזר — ${t.category[p.category]}`} width="sm">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="מה צריך לצלם מחדש? (אופציונלי)" rows={3} autoFocus />
        <div className="mt-6 flex gap-2">
          <Button
            variant="danger"
            onClick={() => {
              setNoteOpen(false);
              onReshoot(note.trim() || null);
            }}
          >
            סימון לצילום חוזר
          </Button>
          <Button onClick={() => setNoteOpen(false)}>ביטול</Button>
        </div>
      </Dialog>
    </>
  );
}

function Tile({
  asset: a,
  index,
  showCategory,
  sortable,
  selected,
  selecting,
  onToggle,
  onOpen,
  onEdit,
  onRotate,
  onPrimary,
  perms,
}: {
  asset: AssetDto;
  index: number;
  showCategory: boolean;
  sortable: boolean;
  selected: boolean;
  selecting: boolean;
  onToggle: (shift: boolean) => void;
  onOpen: () => void;
  onEdit: () => void;
  onRotate: (delta: number) => void;
  onPrimary: () => void;
  perms: { organize: boolean; download: boolean };
}) {
  const toast = useToast();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: a.id, disabled: !sortable });
  const dl = downloadOptions(a);
  const flags = [a.quality?.blurSuspect && "טשטוש?", a.quality?.overexposed && "חשיפת יתר?", a.quality?.underexposed && "כהה?", a.quality?.lowResolution && "רזולוציה נמוכה", a.quality?.duplicateOfAssetId && "כפילות", a.quality?.corrupt && "פגום"].filter(Boolean) as string[];

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("group relative", isDragging && "z-10 opacity-85")}
    >
      <div
        className={cn(
          "relative overflow-hidden rounded-lg bg-stone ring-1 transition-shadow",
          selected ? "ring-2 ring-ink" : "ring-rule group-hover:ring-rule-strong",
          isDragging && "shadow-pop",
        )}
      >
        <button
          type="button"
          onClick={(e) => (selecting ? onToggle(e.shiftKey) : onOpen())}
          className="relative block aspect-[4/3] w-full overflow-hidden"
          aria-label={`הגדלת תמונה ${index + 1}`}
        >
          {a.thumbUrl ? (
            <img src={a.thumbUrl} alt="" loading="lazy" decoding="async" className="size-full object-contain transition-transform duration-300 group-hover:scale-[1.02]" style={cropStyle(a)} />
          ) : (
            <span className="flex size-full items-center justify-center text-[12px] text-muted">{a.processingStatus === "UNSUPPORTED" ? "RAW — אין תצוגה" : a.uploadStatus === "VERIFIED" ? "מעבד…" : "ממתין להעלאה"}</span>
          )}
        </button>

        <label
          className={cn(
            "absolute start-2 top-2 flex size-6 cursor-pointer items-center justify-center rounded-md bg-paper/90 shadow-card ring-1 ring-black/5 transition-opacity",
            selected || selecting ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          )}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={() => undefined}
            onClick={(e) => onToggle(e.shiftKey)}
            aria-label={`בחירת תמונה ${index + 1}`}
            className="size-3.5 accent-[var(--color-ink)]"
          />
        </label>

        {a.isPrimary && (
          <span className="absolute bottom-2 start-2 flex items-center gap-1 rounded-full bg-ink/85 px-2 py-0.5 text-[11px] font-medium text-paper backdrop-blur-sm">
            <Star className="size-3 fill-current" /> ראשית
          </span>
        )}

        {(perms.organize || perms.download) && (
          <div className="absolute end-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {perms.download && (
              <TileAction
                label={dl.primary?.kind === "original" ? "הורדת המקור (התמונה לא עובדה)" : "הורדת התמונה המעובדת"}
                onClick={() => (dl.primary ? startDownload(dl.primary.href) : toast.error(dl.processedMessage ?? PROCESSED_NOT_READY))}
              >
                <Download />
              </TileAction>
            )}
            {perms.organize && !a.isPrimary && (
              <TileAction label="הגדרה כתמונה ראשית" onClick={onPrimary}>
                <Star />
              </TileAction>
            )}
            {perms.organize && (
              <>
                <TileAction label="סיבוב שמאלה" onClick={() => onRotate(-90)}>
                  <RotateCcw />
                </TileAction>
                <TileAction label="סיבוב ימינה" onClick={() => onRotate(90)}>
                  <RotateCw />
                </TileAction>
                <TileAction label="פרטים ועריכה" onClick={onEdit}>
                  <Pencil />
                </TileAction>
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 px-0.5 pt-1.5 text-[12.5px]">
        <span className="num font-semibold">{index + 1}</span>
        <span className="min-w-0 flex-1 truncate text-muted" title={a.displayName ?? undefined}>
          {a.displayName ?? (showCategory ? t.categoryShort[a.category] : `#${a.sequence}`)}
        </span>
        {flags.length > 0 && (
          <span className="flex items-center text-warn" title={`רמזי איכות אוטומטיים (לבדיקה ידנית): ${flags.join(", ")}`} aria-label={`רמזי איכות: ${flags.join(", ")}`}>
            <AlertTriangle className="size-3.5" />
          </span>
        )}
        {a.files.some((f) => f.role === "RAW") && <span className="rounded-xs bg-stone px-1 text-[10px] font-semibold text-ink-2">RAW</span>}
        {sortable && (
          <span
            {...attributes}
            {...listeners}
            className="cursor-grab rounded-md p-0.5 text-faint hover:bg-stone hover:text-ink active:cursor-grabbing"
            aria-label="גרירה לשינוי סדר"
          >
            <GripVertical className="size-3.5" />
          </span>
        )}
      </div>
      {(a.uploadStatus !== "VERIFIED" || a.needsReshoot) && (
        <div className="flex flex-wrap gap-1 px-0.5 pt-1">
          {a.uploadStatus !== "VERIFIED" && <UploadBadge status={a.uploadStatus} />}
          {a.needsReshoot && <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger">לצילום חוזר</span>}
        </div>
      )}
    </li>
  );
}

function TileAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-7 items-center justify-center rounded-md bg-paper/90 text-ink-2 shadow-card ring-1 ring-black/5 backdrop-blur-sm transition-colors hover:bg-paper hover:text-ink [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}

function EditAssetDialog({ asset, onClose, onSaved, canRemove }: { asset: AssetDto; onClose: () => void; onSaved: () => Promise<void>; canRemove: boolean }) {
  const toast = useToast();
  const [displayName, setDisplayName] = useState(asset.displayName ?? "");
  const [notes, setNotes] = useState(asset.notes ?? "");
  const [needsReshoot, setNeedsReshoot] = useState(asset.needsReshoot);
  const [reshootNote, setReshootNote] = useState(asset.reshootNote ?? "");
  const [crop, setCrop] = useState(asset.crop ?? { x: 0, y: 0, w: 1, h: 1 });
  const [saving, setSaving] = useState(false);
  const cropActive = crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1;

  const setEdge = (edge: "l" | "t" | "r" | "b", v: number) => {
    setCrop((c) => {
      const left = edge === "l" ? v : c.x;
      const top = edge === "t" ? v : c.y;
      const right = edge === "r" ? v : 1 - c.x - c.w;
      const bottom = edge === "b" ? v : 1 - c.y - c.h;
      const w = Math.max(0.05, 1 - left - right);
      const h = Math.max(0.05, 1 - top - bottom);
      return { x: left, y: top, w, h };
    });
  };

  async function save() {
    setSaving(true);
    try {
      await api(`/api/assets/${asset.id}`, {
        method: "PATCH",
        json: { displayName: displayName.trim() || null, notes: notes.trim() || null, needsReshoot, reshootNote: reshootNote.trim() || null, crop: cropActive ? crop : null },
      });
      toast.success("השינויים נשמרו");
      await onSaved();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const preview = { ...asset, crop: cropActive ? crop : null };
  return (
    <Dialog open onClose={onClose} title={`צילום ${asset.sequence} · ${t.category[asset.category]}`} width="lg" description={`צולם ${fmt.dateTime(asset.capturedAt)} על ידי ${asset.createdBy?.name ?? "לא ידוע"}`}>
      <div className="grid gap-5 md:grid-cols-[1fr_260px]">
        <div>
          <div className="checker relative aspect-[4/3] overflow-hidden rounded-lg">
            {asset.previewUrl && <img src={asset.previewUrl} alt="" className="size-full object-contain" style={cropStyle(preview as AssetDto)} />}
          </div>
          <fieldset className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px]">
            <legend className="mb-1 text-[12.5px] font-medium text-ink-2">חיתוך תצוגה (לא משנה את קובץ המקור)</legend>
            {(
              [
                ["l", "שמאל", crop.x],
                ["r", "ימין", 1 - crop.x - crop.w],
                ["t", "למעלה", crop.y],
                ["b", "למטה", 1 - crop.y - crop.h],
              ] as const
            ).map(([edge, label, value]) => (
              <label key={edge} className="flex items-center gap-2">
                <span className="w-12 text-muted">{label}</span>
                <input type="range" min={0} max={0.45} step={0.005} value={value} onChange={(e) => setEdge(edge, Number(e.target.value))} className="flex-1 accent-[var(--color-ink)]" dir="ltr" />
                <span className="num w-10 text-start">{Math.round(value * 100)}%</span>
              </label>
            ))}
          </fieldset>
          {cropActive && (
            <button className="mt-1 text-[12.5px] font-medium text-accent-2 hover:underline" onClick={() => setCrop({ x: 0, y: 0, w: 1, h: 1 })}>
              ביטול חיתוך
            </button>
          )}
        </div>
        <div className="space-y-3">
          <Field label="שם תצוגה">{(p) => <Input {...p} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={`צילום ${asset.sequence}`} maxLength={200} />}</Field>
          <Field label="הערות">{(p) => <Textarea {...p} value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={5000} />}</Field>
          <Checkbox label="דורש צילום מחדש" checked={needsReshoot} onChange={(e) => setNeedsReshoot(e.target.checked)} />
          {needsReshoot && <Textarea value={reshootNote} onChange={(e) => setReshootNote(e.target.value)} rows={2} placeholder="מה הבעיה? (מטושטש, השתקפות…)" aria-label="הערת צילום חוזר" />}
          <dl className="space-y-1 border-t border-rule pt-3 text-[12px] text-muted">
            <div className="flex justify-between">
              <dt>רזולוציה</dt>
              <dd className="num">{asset.width ? `${asset.width}×${asset.height}` : "—"}</dd>
            </div>
            {asset.files.map((f) => (
              <div key={f.id} className="flex justify-between">
                <dt>{f.role === "RAW" ? "RAW" : "מקור"}</dt>
                <dd className="num">
                  {f.extension.toUpperCase()} · {fmt.bytes(f.sizeBytes)}
                </dd>
              </div>
            ))}
            <div className="flex justify-between">
              <dt>מקור הצילום</dt>
              <dd>{t.source[asset.source as keyof typeof t.source] ?? asset.source}</dd>
            </div>
          </dl>
          {!canRemove && null}
        </div>
      </div>
      <div className="mt-6 flex gap-2">
        <Button variant="primary" loading={saving} onClick={save}>
          שמירה
        </Button>
        <Button onClick={onClose}>ביטול</Button>
      </div>
    </Dialog>
  );
}

function MoveDialog({
  ids,
  currentLot,
  siblings,
  onClose,
  onDone,
}: {
  ids: string[] | null;
  currentLot: { id: string; lotNumber: number; title: string };
  siblings: { id: string; lotNumber: number; title: string }[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const toast = useToast();
  const [lotId, setLotId] = useState(currentLot.id);
  const [category, setCategory] = useState<PhotoCategory>("INTERIOR");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const otherLot = lotId !== currentLot.id;
  const target = siblings.find((s) => s.id === lotId);

  async function submit() {
    if (!ids) return;
    setBusy(true);
    try {
      await api("/api/assets/move", { method: "POST", json: { assetIds: ids, targetLotId: lotId, targetCategory: category, confirmLotChange: otherLot ? confirmed : undefined } });
      toast.success(otherLot ? `${ids.length} תמונות הועברו לפריט ${target?.lotNumber}` : `${ids.length} תמונות הועברו ל${t.category[category]}`);
      await onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!ids} onClose={onClose} title={`העברת ${ids?.length ?? 0} תמונות`} width="sm">
      <div className="space-y-3">
        <Field label="ספר יעד">
          {(p) => (
            <Select {...p} value={lotId} onChange={(e) => { setLotId(e.target.value); setConfirmed(false); }}>
              <option value={currentLot.id}>
                {currentLot.lotNumber} · {currentLot.title} (הספר הנוכחי)
              </option>
              {siblings.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.lotNumber} · {s.title}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="קטגוריית יעד">
          {(p) => (
            <Select {...p} value={category} onChange={(e) => setCategory(e.target.value as PhotoCategory)}>
              {PHOTO_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t.category[c]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {otherLot && (
          <div className="rounded-md bg-warn-soft px-3 py-2.5 text-[13px] text-warn">
            <p>
              התמונות יועברו לספר אחר: פריט <span className="num font-semibold">{target?.lotNumber}</span> · {target?.title}.
            </p>
            <Checkbox className="mt-2 text-ink" label="אני מאשר/ת שהתמונות שייכות לספר זה" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          </div>
        )}
      </div>
      <div className="mt-6 flex gap-2">
        <Button variant="primary" loading={busy} disabled={otherLot && !confirmed} onClick={submit}>
          העברה
        </Button>
        <Button onClick={onClose}>ביטול</Button>
      </div>
    </Dialog>
  );
}

/** Side-by-side comparison with synchronised zoom & pan — for picking the sharper shot. */
function CompareView({ pair, onClose }: { pair: [AssetDto, AssetDto]; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const [origin, setOrigin] = useState({ x: 50, y: 50 });
  const [full, setFull] = useState(false);
  return (
    <div className="fixed inset-0 z-[90] flex flex-col bg-studio text-studio-text" role="dialog" aria-modal="true" aria-label="השוואת תמונות" onKeyDown={(e) => e.key === "Escape" && onClose()} tabIndex={-1} ref={(el) => el?.focus()}>
      <div className="flex h-11 items-center gap-3 border-b border-studio-rule px-3 text-[13px]">
        <span className="font-medium">השוואה</span>
        <span className="text-studio-muted">הזזת העכבר מזיזה את שתי התמונות יחד</span>
        <div className="ms-auto flex items-center gap-1">
          {[1, 2, 4].map((z) => (
            <button key={z} className={cn("num rounded-md px-2.5 py-1 hover:bg-studio-3", zoom === z && "bg-studio-3")} onClick={() => setZoom(z)}>
              {z}×
            </button>
          ))}
          <button className={cn("rounded-sm px-2 py-1 text-[12px] hover:bg-studio-3", full && "bg-studio-3")} onClick={() => setFull((f) => !f)} title="טעינת קבצי המקור">
            מקור
          </button>
          <button className="ms-2 rounded-sm px-2 py-1 hover:bg-studio-3" onClick={onClose}>
            סגירה (Esc)
          </button>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-px bg-studio-rule">
        {pair.map((a) => (
          <div
            key={a.id}
            className="checker relative overflow-hidden"
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setOrigin({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 });
            }}
          >
            <img
              src={full ? `/api/assets/${a.id}/original` : (a.previewUrl ?? "")}
              alt=""
              className="size-full object-contain"
              style={{ transform: `scale(${zoom}) rotate(${a.rotation}deg)`, transformOrigin: `${origin.x}% ${origin.y}%` }}
            />
            <div className="absolute bottom-2 start-2 rounded-sm bg-black/60 px-2 py-1 text-[12px]">
              צילום {a.sequence} · {a.width}×{a.height}
              {a.quality?.metrics?.sharpness !== undefined && <span className="text-studio-muted"> · מדד חדות {a.quality.metrics.sharpness}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
