"use client";

import { useEffect, useRef } from "react";
import { AlertTriangle, Check, CloudUpload, Crop, HardDrive, Loader2, Maximize2, RotateCcw, Star, Trash2, XCircle } from "lucide-react";
import type { CaptureStage, PhotoCategory } from "@avot/shared";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";

export interface StripItem {
  key: string;
  captureId: string;
  assetId?: string;
  category: PhotoCategory;
  seq?: number;
  stage: CaptureStage;
  src: string | null;
  rotation: number;
  isPrimary: boolean;
  error?: string | null;
  /** green-screen processing of this photo (null = not processed) */
  processing?: { state: "QUEUED" | "PREVIEW_READY" | "DONE" | "NEEDS_REVIEW" | "FAILED"; warnings: string[] } | null;
  createdAt: number;
}

const STAGE_ICON: Record<CaptureStage, React.ReactNode> = {
  CAPTURING: <Loader2 className="size-3 animate-spin" />,
  SAVED_LOCAL: <HardDrive className="size-3" />,
  QUEUED: <CloudUpload className="size-3" />,
  UPLOADING: <Loader2 className="size-3 animate-spin" />,
  VERIFIED: <Check className="size-3" />,
  FAILED: <XCircle className="size-3" />,
  NEEDS_ATTENTION: <AlertTriangle className="size-3" />,
};

const STAGE_TONE: Record<CaptureStage, string> = {
  CAPTURING: "bg-studio-3 text-studio-text",
  SAVED_LOCAL: "bg-[#4a3a1a] text-[#f2d79e]",
  QUEUED: "bg-[#4a3a1a] text-[#f2d79e]",
  UPLOADING: "bg-[#1b3550] text-[#b8d6f5]",
  VERIFIED: "bg-[#173d2b] text-[#9fe3c0]",
  FAILED: "bg-[#4a1d1a] text-[#f6c3bb]",
  NEEDS_ATTENTION: "bg-[#4a1d1a] text-[#f6c3bb]",
};

export function Filmstrip({
  items,
  replaceTarget,
  onOpen,
  onDelete,
  onRetake,
  onPrimary,
  onRetryUpload,
  onEdit,
  canOrganize,
  canDelete,
  showCategory,
}: {
  items: StripItem[];
  replaceTarget: string | null;
  onOpen: (i: number) => void;
  onDelete: (item: StripItem) => void;
  onRetake: (item: StripItem) => void;
  onPrimary: (item: StripItem) => void;
  onRetryUpload: (item: StripItem) => void;
  onEdit: (item: StripItem) => void;
  canOrganize: boolean;
  canDelete: boolean;
  showCategory: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const count = items.length;
  useEffect(() => {
    // newest shot is last — keep it in view (RTL: scroll to the far "end" = left)
    const el = scroller.current;
    if (el) el.scrollTo({ left: -el.scrollWidth, behavior: "smooth" });
  }, [count]);

  if (!items.length) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-studio-muted">
        עדיין אין צילומים בקטגוריה זו — לחצו על הכפתור או על
        <kbd className="rounded-xs bg-studio-3 px-1.5 py-0.5 font-mono text-[11px] text-studio-text">רווח</kbd>
      </div>
    );
  }

  return (
    <div ref={scroller} className="flex h-full items-stretch gap-2.5 overflow-x-auto overflow-y-hidden px-3 py-2.5" role="list" aria-label="צילומים אחרונים">
      {items.map((it, i) => {
        const deletable = !!it.assetId && it.stage === "VERIFIED";
        return (
          <div
            key={it.key}
            role="listitem"
            data-testid="strip-item"
            data-stage={it.stage}
            data-category={it.category}
            data-capture-id={it.captureId}
            className={cn(
              "group relative flex h-full w-[124px] shrink-0 flex-col overflow-hidden rounded-lg bg-studio-3 ring-1 transition-shadow",
              replaceTarget && replaceTarget === it.assetId ? "ring-2 ring-[#e8b04b]" : it.isPrimary ? "ring-studio-text/50" : "ring-studio-rule hover:ring-studio-muted/60",
            )}
          >
            <button
              type="button"
              className="relative min-h-0 flex-1 overflow-hidden bg-black/40"
              onClick={() => onOpen(i)}
              aria-label={`הגדלת צילום ${it.seq ?? ""}`}
              disabled={!it.src}
            >
              {it.src ? (
                <img src={it.src} alt="" className="size-full object-contain" style={{ transform: it.rotation ? `rotate(${it.rotation}deg)` : undefined }} loading="lazy" decoding="async" />
              ) : (
                <span className="flex size-full items-center justify-center text-[11px] text-studio-muted">{it.stage === "FAILED" ? "לא נשמר" : "…"}</span>
              )}
              <span className="absolute inset-0 hidden items-center justify-center bg-black/35 group-hover:flex">
                <Maximize2 className="size-4 text-white" />
              </span>
            </button>
            <div className="flex h-7 shrink-0 items-center gap-1 px-2 text-[11.5px]">
              <span className="num font-semibold text-studio-text">{it.seq ?? "—"}</span>
              {showCategory && <span className="truncate text-studio-muted">{t.categoryShort[it.category]}</span>}
              {it.processing && it.stage === "VERIFIED" && <ProcessingChip state={it.processing.state} warnings={it.processing.warnings} />}
              <span
                className={cn("ms-auto flex items-center gap-1 rounded-full px-1.5 py-0.5", STAGE_TONE[it.stage])}
                title={it.error ? `${t.uploadStage[it.stage]}: ${it.error}` : t.uploadStage[it.stage]}
              >
                {STAGE_ICON[it.stage]}
              </span>
            </div>
            {it.isPrimary && (
              <span className="absolute start-1.5 top-1.5 rounded-full bg-black/65 p-1" title="תמונה ראשית">
                <Star className="size-3 fill-[#e8b04b] text-[#e8b04b]" />
              </span>
            )}
            <div className="absolute end-1.5 top-1.5 hidden gap-1 group-hover:flex group-focus-within:flex">
              {canOrganize && deletable && (
                <button className="rounded-md bg-black/70 p-1.5 text-white backdrop-blur-sm hover:bg-black" onClick={() => onEdit(it)} title="תיקון חיתוך / רקע" aria-label="תיקון חיתוך ורקע" data-testid="strip-edit">
                  <Crop className="size-3" />
                </button>
              )}
              {canOrganize && deletable && !it.isPrimary && (
                <button className="rounded-md bg-black/70 p-1.5 text-white backdrop-blur-sm hover:bg-black" onClick={() => onPrimary(it)} title="הגדרה כתמונה ראשית" aria-label="הגדרה כתמונה ראשית">
                  <Star className="size-3" />
                </button>
              )}
              {canDelete && deletable && (
                <button className="rounded-md bg-black/70 p-1.5 text-white backdrop-blur-sm hover:bg-black" onClick={() => onRetake(it)} title="צילום מחדש — הצילום הבא יחליף תמונה זו (לאחר אישור)" aria-label="צילום מחדש">
                  <RotateCcw className="size-3" />
                </button>
              )}
              {canDelete && deletable && (
                <button className="rounded-md bg-black/70 p-1.5 text-white backdrop-blur-sm hover:bg-danger" onClick={() => onDelete(it)} title="העברה לסל המחזור" aria-label="מחיקה">
                  <Trash2 className="size-3" />
                </button>
              )}
              {(it.stage === "NEEDS_ATTENTION" || it.stage === "QUEUED") && !it.assetId && (
                <button className="rounded-md bg-black/70 p-1.5 text-white backdrop-blur-sm hover:bg-black" onClick={() => onRetryUpload(it)} title="ניסיון העלאה חוזר עכשיו" aria-label="ניסיון העלאה חוזר">
                  <CloudUpload className="size-3" />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Processing state of a photo in the strip: working, needs a look, failed. Finished photos show nothing extra. */
function ProcessingChip({ state, warnings }: { state: NonNullable<StripItem["processing"]>["state"]; warnings: string[] }) {
  if (state === "DONE") return null;
  const label = state === "NEEDS_REVIEW" ? "לבדיקה" : state === "FAILED" ? "עיבוד נכשל" : "מעבד";
  const tone = state === "NEEDS_REVIEW" ? "bg-[#4a3a1a] text-[#f2d79e]" : state === "FAILED" ? "bg-[#4a1d1a] text-[#f6c3bb]" : "bg-studio-2 text-studio-muted";
  return (
    <span className={cn("flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px]", tone)} title={warnings.length ? warnings.join(" · ") : label} data-testid="processing-chip" data-state={state}>
      {state === "QUEUED" || state === "PREVIEW_READY" ? <Loader2 className="size-2.5 animate-spin" /> : state === "NEEDS_REVIEW" ? <AlertTriangle className="size-2.5" /> : <XCircle className="size-2.5" />}
      {label}
    </span>
  );
}

