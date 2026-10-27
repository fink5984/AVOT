"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Maximize, Minus, Plus, X } from "lucide-react";
import { fmt, t } from "@/i18n";
import { cn } from "@/lib/cn";

export interface ViewerItem {
  key: string;
  title: string;
  /** fast preview (≤2048px) */
  src: string | null;
  /** full-resolution image that matches the preview's look (processed when available), loaded on demand for sharp display / 1:1 */
  fullSrc?: string | null;
  /** full-resolution original, loaded on demand for 1:1 inspection */
  originalSrc?: string | null;
  downloadHref?: string | null;
  rotation?: number;
  details?: { label: string; value: React.ReactNode }[];
  warnings?: string[];
}

/**
 * Full-screen viewer. Esc closes, ←/→ navigate, +/− or wheel zoom, drag to pan,
 * "1" toggles 100% (loads the original to check sharpness).
 */
export function ImageViewer({ items, index, onIndex, onClose }: { items: ViewerItem[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const item = items[index];
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hires, setHires] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [showInfo, setShowInfo] = useState(true);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setNatural(null);
  }, [index]);

  const hiResSrc = item?.fullSrc ?? item?.originalSrc ?? null;
  // show the fast preview instantly, then swap to the full-resolution picture once it has fully loaded (from cache, so no flash)
  useEffect(() => {
    setHires(false);
    if (!hiResSrc) return;
    let alive = true;
    const im = new Image();
    im.onload = () => alive && setHires(true);
    im.src = hiResSrc;
    return () => {
      alive = false;
      im.onload = null;
    };
  }, [hiResSrc, index]);

  /** zoom that makes one image pixel equal one screen pixel */
  const oneToOne = useCallback(() => {
    const img = imgRef.current;
    if (!img || !natural) return 2;
    const shown = img.getBoundingClientRect().width / zoom;
    return shown ? natural.w / shown : 2;
  }, [natural, zoom]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onIndex(Math.min(items.length - 1, index + 1)); // RTL: left = next
      else if (e.key === "ArrowRight") onIndex(Math.max(0, index - 1));
      else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(16, z * 1.5));
      else if (e.key === "-") setZoom((z) => Math.max(1, z / 1.5));
      else if (e.code === "Digit1" || e.code === "Numpad1") {
        setZoom((z) => (z > 1 ? 1 : oneToOne()));
      } else if (e.code === "KeyI") setShowInfo((s) => !s);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, items.length, onClose, onIndex, oneToOne]);

  if (!item) return null;
  const src = hires && hiResSrc ? hiResSrc : item.src;

  return (
    <div className="fixed inset-0 z-[90] flex flex-col bg-studio text-studio-text" role="dialog" aria-modal="true" aria-label={item.title}>
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-studio-rule px-3">
        <span className="truncate text-[13px] font-medium">{item.title}</span>
        <span className="num text-[12px] text-studio-muted">
          {index + 1}/{items.length}
        </span>
        <div className="ms-auto flex items-center gap-1">
          <button className="rounded-sm p-1.5 hover:bg-studio-3" onClick={() => setZoom((z) => Math.max(1, z / 1.5))} aria-label="הקטנה">
            <Minus className="size-4" />
          </button>
          <span className="num w-12 text-center text-[12px]">{Math.round(zoom * 100)}%</span>
          <button className="rounded-sm p-1.5 hover:bg-studio-3" onClick={() => setZoom((z) => Math.min(16, z * 1.5))} aria-label="הגדלה">
            <Plus className="size-4" />
          </button>
          {hiResSrc && (
            <button
              className={cn("rounded-sm px-2 py-1 text-[12px] hover:bg-studio-3", zoom > 1 && "bg-studio-3")}
              onClick={() => setZoom((z) => (z > 1 ? 1 : oneToOne()))}
              title="בדיקת חדות ברזולוציה מלאה (מקש 1)"
            >
              1:1
            </button>
          )}
          <button className="rounded-sm p-1.5 hover:bg-studio-3" onClick={() => stage.current?.requestFullscreen?.()} aria-label="מסך מלא">
            <Maximize className="size-4" />
          </button>
          <button className={cn("rounded-sm px-2 py-1 text-[12px] hover:bg-studio-3", showInfo && "bg-studio-3")} onClick={() => setShowInfo((s) => !s)}>
            פרטים
          </button>
          {item.downloadHref && (
            <a href={item.downloadHref} className="rounded-sm p-1.5 hover:bg-studio-3" aria-label="הורדת המקור" title="הורדת קובץ המקור">
              <Download className="size-4" />
            </a>
          )}
          <button className="ms-2 rounded-sm p-1.5 hover:bg-studio-3" onClick={onClose} aria-label="סגירה (Esc)">
            <X className="size-4.5" />
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          ref={stage}
          className="checker relative flex min-w-0 flex-1 items-center justify-center overflow-hidden"
          onWheel={(e) => setZoom((z) => Math.max(1, Math.min(16, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))))}
          onPointerDown={(e) => {
            if (zoom === 1) return;
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d) setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
          }}
          onPointerUp={() => (drag.current = null)}
          style={{ cursor: zoom > 1 ? "grab" : "default" }}
        >
          {src ? (
            <img
              ref={imgRef}
              src={src}
              alt={item.title}
              draggable={false}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              className="max-h-full max-w-full select-none object-contain"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${item.rotation ?? 0}deg)`, transition: drag.current ? "none" : "transform 80ms" }}
            />
          ) : (
            <p className="text-[13px] text-studio-muted">אין תצוגה מקדימה לקובץ זה (למשל RAW בלבד). ניתן להוריד את המקור.</p>
          )}
          {index > 0 && (
            <button className="absolute end-auto start-3 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 hover:bg-black/60" onClick={() => onIndex(index - 1)} aria-label="הקודם">
              <ChevronRight className="size-5" />
            </button>
          )}
          {index < items.length - 1 && (
            <button className="absolute end-3 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 hover:bg-black/60" onClick={() => onIndex(index + 1)} aria-label="הבא">
              <ChevronLeft className="size-5" />
            </button>
          )}
        </div>
        {showInfo && (item.details?.length || item.warnings?.length) ? (
          <aside className="hidden w-72 shrink-0 overflow-y-auto border-s border-studio-rule bg-studio-2 px-4 py-3 text-[12.5px] md:block">
            {item.warnings && item.warnings.length > 0 && (
              <div className="mb-3 rounded-sm border border-[#a8741a]/50 bg-[#a8741a]/10 px-2.5 py-2 text-[#e8c27a]">
                <div className="mb-1 font-medium">רמזי איכות אוטומטיים (לבדיקה ידנית)</div>
                <ul className="list-disc ps-4">
                  {item.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            <dl className="space-y-2">
              {item.details?.map((d) => (
                <div key={d.label}>
                  <dt className="text-[11px] text-studio-muted">{d.label}</dt>
                  <dd className="break-words">{d.value}</dd>
                </div>
              ))}
              {natural && (
                <div>
                  <dt className="text-[11px] text-studio-muted">רזולוציה מוצגת כעת</dt>
                  <dd className="num text-start">
                    {natural.w}×{natural.h} {hires ? "(רזולוציה מלאה)" : "(תצוגה מקדימה)"}
                  </dd>
                </div>
              )}
            </dl>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/** Viewer details for a server asset. */
export function assetViewerDetails(a: {
  category: keyof typeof t.category;
  width: number | null;
  height: number | null;
  capturedAt: string;
  createdBy: { name: string } | null;
  source: string;
  cameraName: string | null;
  uploadStatus: keyof typeof t.serverUpload;
  files: { role: string; extension: string; sizeBytes: number; sha256: string }[];
  notes: string | null;
  quality: { lowResolution?: boolean; overexposed?: boolean; underexposed?: boolean; blurSuspect?: boolean; corrupt?: boolean; duplicateOfAssetId?: string } | null;
}) {
  const warnings: string[] = [];
  const q = a.quality;
  if (q?.corrupt) warnings.push("לא ניתן היה לפענח את הקובץ — ייתכן שהוא פגום");
  if (q?.lowResolution) warnings.push("רזולוציה נמוכה מהמומלץ");
  if (q?.blurSuspect) warnings.push("חשד לטשטוש — בדקו ב-1:1");
  if (q?.overexposed) warnings.push("אזורים בהירים שרופים");
  if (q?.underexposed) warnings.push("התמונה כהה מאוד");
  if (q?.duplicateOfAssetId) warnings.push("קובץ זהה כבר קיים במערכת (כפילות)");
  return {
    warnings,
    details: [
      { label: "קטגוריה", value: t.category[a.category] },
      { label: "רזולוציית מקור", value: a.width ? <span className="num">{`${a.width}×${a.height} (${((a.width * (a.height ?? 0)) / 1e6).toFixed(1)}MP)`}</span> : "—" },
      { label: "צולם", value: `${fmt.dateTime(a.capturedAt)} · ${a.createdBy?.name ?? "לא ידוע"}` },
      { label: "מקור", value: `${t.source[a.source as keyof typeof t.source] ?? a.source}${a.cameraName ? ` · ${a.cameraName}` : ""}` },
      { label: "מצב שמירה", value: t.serverUpload[a.uploadStatus] },
      ...a.files.map((f) => ({
        label: f.role === "RAW" ? "קובץ RAW" : "קובץ מקור",
        value: (
          <span>
            <span className="num">{f.extension.toUpperCase()} · {fmt.bytes(f.sizeBytes)}</span>
            <span className="mt-0.5 block font-mono text-[10.5px] text-studio-muted" dir="ltr">
              SHA-256 {f.sha256.slice(0, 16)}…
            </span>
          </span>
        ),
      })),
      ...(a.notes ? [{ label: "הערות", value: a.notes }] : []),
    ],
  };
}
