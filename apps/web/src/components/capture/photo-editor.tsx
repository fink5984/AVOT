"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crop, Eraser, Paintbrush, RotateCcw, RotateCw, Undo2 } from "lucide-react";
import { DEFAULT_PROCESSING, parseHexColor, type ManualEdits, type ProcessingSettings } from "@avot/shared";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { segmentBook } from "@/lib/imaging/segment";
import { EdgeCompare } from "./edge-compare";
import type { AssetDto } from "@/server/services/asset-dto";

type Tool = "erase" | "keep" | "crop";
type Strokes = NonNullable<ManualEdits["strokes"]>;
type Crop = NonNullable<ManualEdits["crop"]>;

const WORK = 640;

const EDGE_LABELS: { id: ProcessingSettings["edgeQuality"]; label: string; hint: string }[] = [
  { id: "precise", label: "מדויק", hint: "קצה חד ונקי" },
  { id: "natural", label: "טבעי", hint: "קצה רך ללא ירוק — ברירת המחדל" },
  { id: "soft", label: "רך", hint: "מעבר רחב יותר — פינות שחוקות, בד" },
];

/**
 * Quick correction of one processed photo — not a photo editor. The estimate on screen is computed
 * with the same segmentation the server uses; saving sends only the settings and the brush / crop
 * marks, and the server redoes the work from the untouched original at full resolution.
 */
export function PhotoEditorDialog({ asset, onClose, onSaved }: { asset: AssetDto | null; onClose: () => void; onSaved: (a: AssetDto) => void }) {
  const toast = useToast();
  const initial = asset?.processed?.settings ?? DEFAULT_PROCESSING;
  const [settings, setSettings] = useState<ProcessingSettings>(initial);
  const [strokes, setStrokes] = useState<Strokes>(asset?.processed?.edits?.strokes ?? []);
  const [crop, setCrop] = useState<Crop | null>(asset?.processed?.edits?.crop ?? null);
  const [tool, setTool] = useState<Tool>("erase");
  const [brush, setBrush] = useState(0.025);
  const [showOriginal, setShowOriginal] = useState(false);
  const [compare, setCompare] = useState(false);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const draft = useRef<{ mode: "erase" | "keep"; pts: [number, number][] } | null>(null);
  const cropDrag = useRef<{ x: number; y: number } | null>(null);
  const [draftTick, setDraftTick] = useState(0);
  const [cropDraft, setCropDraft] = useState<Crop | null>(null);

  // reset when another photo is opened
  const assetId = asset?.id;
  useEffect(() => {
    if (!asset) return;
    const s = asset.processed?.settings ?? DEFAULT_PROCESSING;
    setSettings(s);
    setStrokes(asset.processed?.edits?.strokes ?? []);
    setCrop(asset.processed?.edits?.crop ?? null);
    setShowOriginal(false);
    setCompare(false);
    setTool("erase");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId]);

  // the same orientation the server will process (rotation is relative to the camera sensor)
  useEffect(() => {
    if (!assetId) return;
    setImg(null);
    setLoadError(null);
    const el = new Image();
    el.onload = () => setImg(el);
    el.onerror = () => setLoadError("לא ניתן לטעון את התמונה לעריכה");
    el.src = `/api/assets/${assetId}/edit-source?rotation=${settings.rotation}`;
  }, [assetId, settings.rotation]);

  // working copy for the live estimate
  const work = useMemo(() => {
    if (!img) return null;
    const scale = Math.min(1, WORK / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, w, h);
    return { w, h, data: ctx.getImageData(0, 0, w, h) };
  }, [img]);

  const [result, setResult] = useState<ReturnType<typeof segmentBook> | null>(null);
  useEffect(() => {
    if (!work) return;
    const id = setTimeout(() => {
      setResult(segmentBook({ data: work.data.data, width: work.w, height: work.h, channels: 4 }, { sensitivity: settings.sensitivity, bgSample: settings.bgSample, strokes }));
    }, 120);
    return () => clearTimeout(id);
  }, [work, settings.sensitivity, settings.bgSample, strokes]);

  // draw: processed estimate, crop frame, strokes in progress
  useEffect(() => {
    const c = canvas.current;
    if (!c || !work) return;
    c.width = work.w;
    c.height = work.h;
    const ctx = c.getContext("2d")!;
    const src = work.data.data;
    const out = ctx.createImageData(work.w, work.h);
    const fill = settings.background === "transparent" ? null : parseHexColor(settings.background);
    for (let y = 0, i = 0; y < work.h; y++) {
      for (let x = 0; x < work.w; x++, i++) {
        const a = showOriginal || !settings.removeBackground || !result ? 1 : result.alpha[i]! / 255;
        const p = i * 4;
        const chk = ((x >> 3) + (y >> 3)) & 1 ? 214 : 245;
        const br = fill ? fill[0] : chk;
        const bg = fill ? fill[1] : chk;
        const bb = fill ? fill[2] : chk;
        out.data[p] = src[p]! * a + br * (1 - a);
        out.data[p + 1] = src[p + 1]! * a + bg * (1 - a);
        out.data[p + 2] = src[p + 2]! * a + bb * (1 - a);
        out.data[p + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);

    const line = Math.max(2, work.w / 260);
    const frame = crop ?? (result?.bbox && settings.autoCrop ? autoFrame(result.bbox, settings.marginPct, work.w, work.h) : null);
    if (frame) {
      ctx.lineWidth = line;
      ctx.strokeStyle = crop ? "rgba(207,68,22,0.95)" : "rgba(40,40,40,0.8)";
      ctx.setLineDash(crop ? [] : [8, 6]);
      ctx.strokeRect(frame.x * work.w, frame.y * work.h, frame.w * work.w, frame.h * work.h);
      ctx.setLineDash([]);
    }
    const drawStroke = (s: { mode: "erase" | "keep"; r: number; pts: [number, number][] }, alpha: number) => {
      ctx.lineCap = ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(2, s.r * Math.max(work.w, work.h) * 2);
      ctx.strokeStyle = s.mode === "erase" ? `rgba(220,40,40,${alpha})` : `rgba(30,150,80,${alpha})`;
      ctx.beginPath();
      s.pts.forEach(([x, y], k) => (k ? ctx.lineTo(x * work.w, y * work.h) : ctx.moveTo(x * work.w, y * work.h)));
      if (s.pts.length === 1) ctx.lineTo(s.pts[0]![0] * work.w + 0.01, s.pts[0]![1] * work.h);
      ctx.stroke();
    };
    if (draft.current) drawStroke({ ...draft.current, r: brush }, 0.55);
    if (cropDraft) {
      ctx.lineWidth = line;
      ctx.strokeStyle = "rgba(207,68,22,0.95)";
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(cropDraft.x * work.w, cropDraft.y * work.h, cropDraft.w * work.w, cropDraft.h * work.h);
      ctx.setLineDash([]);
    }
  }, [work, result, settings.background, settings.removeBackground, settings.autoCrop, settings.marginPct, crop, cropDraft, showOriginal, draftTick, brush]);

  const pos = (e: React.PointerEvent): [number, number] => {
    const r = canvas.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const down = (e: React.PointerEvent) => {
    if (!work) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = pos(e);
    if (tool === "crop") cropDrag.current = { x: p[0], y: p[1] };
    else draft.current = { mode: tool, pts: [p] };
    setDraftTick((n) => n + 1);
  };
  const move = (e: React.PointerEvent) => {
    const p = pos(e);
    if (cropDrag.current) {
      const o = cropDrag.current;
      setCropDraft({ x: Math.min(o.x, p[0]), y: Math.min(o.y, p[1]), w: Math.max(0.01, Math.abs(p[0] - o.x)), h: Math.max(0.01, Math.abs(p[1] - o.y)) });
    } else if (draft.current) {
      draft.current.pts.push(p);
      setDraftTick((n) => n + 1);
    }
  };
  const up = () => {
    if (cropDrag.current && cropDraft && cropDraft.w > 0.03 && cropDraft.h > 0.03) setCrop(cropDraft);
    cropDrag.current = null;
    setCropDraft(null);
    const d = draft.current;
    draft.current = null;
    if (d && d.pts.length) setStrokes((s) => [...s, { mode: d.mode, r: brush, pts: thin(d.pts) }].slice(-300));
    setDraftTick((n) => n + 1);
  };

  const rotate = (delta: number) => {
    setSettings((s) => ({ ...s, rotation: ((((s.rotation + delta) % 360) + 360) % 360) as ProcessingSettings["rotation"] }));
    // marks are positions on the rotated picture; they do not carry over
    setStrokes([]);
    setCrop(null);
  };

  const save = useCallback(async () => {
    if (!asset) return;
    setBusy(true);
    try {
      const r = await api<{ asset: AssetDto }>(`/api/assets/${asset.id}/process`, {
        method: "POST",
        json: {
          settings: {
            rotation: settings.rotation,
            sensitivity: settings.sensitivity,
            edgeQuality: settings.edgeQuality,
            marginPct: settings.marginPct,
            background: settings.background,
            removeBackground: settings.removeBackground,
            autoCrop: settings.autoCrop,
          },
          edits: { crop, strokes },
        },
      });
      toast.success("התמונה עודכנה — הגרסה המלאה מתעדכנת ברקע");
      onSaved(r.asset);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [asset, crop, onClose, onSaved, settings, strokes, toast]);

  const restore = async () => {
    if (!asset) return;
    setBusy(true);
    try {
      const r = await api<{ asset: AssetDto }>(`/api/assets/${asset.id}/process`, { method: "POST", json: { restore: true } });
      toast.success("הוחזרה תמונת המקור");
      onSaved(r.asset);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const warnings = asset?.processed?.warnings ?? [];
  const tools: { id: Tool; label: string; icon: React.ReactNode }[] = [
    { id: "erase", label: "מחיקת רקע שנשאר", icon: <Eraser /> },
    { id: "keep", label: "החזרת חלק מהספר", icon: <Paintbrush /> },
    { id: "crop", label: "חיתוך ידני", icon: <Crop /> },
  ];

  return (
    <Dialog open={!!asset} onClose={onClose} title={asset ? `עריכת צילום ${asset.sequence}` : "עריכה"} width="xl">
      {asset && (
        <div className="space-y-3 text-[13.5px]">
          {asset.processed?.state === "NEEDS_REVIEW" && (
            <p className="rounded-md bg-warn-soft px-3 py-2 text-warn">הזיהוי האוטומטי לא היה בטוח{warnings.length ? ` (${warnings.map(warningLabel).join(", ")})` : ""} — לא בוצע חיתוך או הסרת רקע. סמנו, בדקו ושמרו.</p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {tools.map((t) => (
              <Button key={t.id} size="sm" variant={tool === t.id ? "primary" : "secondary"} icon={t.icon} onClick={() => setTool(t.id)} aria-pressed={tool === t.id}>
                {t.label}
              </Button>
            ))}
            <label className="ms-2 flex items-center gap-2 text-[12.5px] text-muted">
              מברשת
              <input type="range" min={0.008} max={0.06} step={0.002} value={brush} onChange={(e) => setBrush(Number(e.target.value))} className="w-24 accent-[var(--color-ink)]" dir="ltr" aria-label="גודל מברשת" />
            </label>
            <span className="ms-auto flex gap-1.5">
              <Button size="sm" icon={<Undo2 />} disabled={!strokes.length && !crop} onClick={() => (crop && !strokes.length ? setCrop(null) : setStrokes((s) => s.slice(0, -1)))} aria-label="ביטול פעולה אחרונה">
                ביטול
              </Button>
              <Button size="sm" icon={<RotateCcw />} onClick={() => rotate(-90)} aria-label="סיבוב שמאלה" />
              <Button size="sm" icon={<RotateCw />} onClick={() => rotate(90)} aria-label="סיבוב ימינה" />
            </span>
          </div>

          {compare && work && (
            <EdgeCompare assetId={asset.id} settings={settings} result={result} workW={work.w} workH={work.h} />
          )}
          <div className={cn("checker relative flex max-h-[56vh] min-h-[240px] items-center justify-center overflow-hidden rounded-lg bg-stone", compare && "hidden")}>
            {loadError ? (
              <p className="p-8 text-danger">{loadError}</p>
            ) : !work ? (
              <p className="p-8 text-muted">טוען…</p>
            ) : (
              <canvas
                ref={canvas}
                className={cn("max-h-[56vh] w-auto max-w-full touch-none select-none", tool === "crop" ? "cursor-crosshair" : "cursor-cell")}
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
                data-testid="editor-canvas"
              />
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 flex justify-between"><span>רגישות זיהוי רקע ירוק</span><span className="num text-muted">{settings.sensitivity}</span></span>
              <input type="range" min={0} max={100} step={5} value={settings.sensitivity} onChange={(e) => setSettings((s) => ({ ...s, sensitivity: Number(e.target.value) }))} className="w-full accent-[var(--color-ink)]" dir="ltr" />
            </label>
            <label className="block">
              <span className="mb-1 flex justify-between"><span>שוליים</span><span className="num text-muted">{settings.marginPct}%</span></span>
              <input type="range" min={0} max={15} step={0.5} value={settings.marginPct} onChange={(e) => { setSettings((s) => ({ ...s, marginPct: Number(e.target.value) })); setCrop(null); }} className="w-full accent-[var(--color-ink)]" dir="ltr" />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="איכות הקצה">
            <span className="me-1 text-muted">איכות הקצה</span>
            {EDGE_LABELS.map((q) => (
              <Button key={q.id} size="sm" variant={settings.edgeQuality === q.id ? "primary" : "secondary"} aria-pressed={settings.edgeQuality === q.id} title={q.hint} onClick={() => setSettings((st) => ({ ...st, edgeQuality: q.id }))}>
                {q.label}
              </Button>
            ))}
            <Button size="sm" className="ms-auto" variant={compare ? "primary" : "secondary"} aria-pressed={compare} onClick={() => setCompare((c) => !c)} disabled={!work}>
              {compare ? "חזרה לעריכה" : "השוואה לפני / אחרי"}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant={settings.background === "transparent" ? "primary" : "secondary"} onClick={() => setSettings((s) => ({ ...s, background: s.background === "transparent" ? "#ffffff" : "transparent" }))} aria-pressed={settings.background === "transparent"}>
              {settings.background === "transparent" ? "רקע שקוף (PNG)" : "רקע לבן — מעבר לשקוף"}
            </Button>
            <Button size="sm" onMouseDown={() => setShowOriginal(true)} onMouseUp={() => setShowOriginal(false)} onMouseLeave={() => setShowOriginal(false)} onKeyDown={(e) => e.key === " " && setShowOriginal(true)} onKeyUp={() => setShowOriginal(false)}>
              החזיקו להצגת המקור
            </Button>
            <Button size="sm" variant="ghost" disabled={!crop && !strokes.length} onClick={() => { setCrop(null); setStrokes([]); }}>
              ניקוי סימונים
            </Button>
          </div>
        </div>
      )}
      <div className="mt-5 flex flex-wrap gap-2">
        <Button variant="primary" loading={busy} onClick={save} disabled={!work}>
          שמירה
        </Button>
        <Button onClick={onClose} disabled={busy}>
          ביטול
        </Button>
        <Button variant="danger" className="ms-auto" onClick={restore} disabled={busy || asset?.processed?.state === undefined}>
          שחזור המקור
        </Button>
      </div>
    </Dialog>
  );
}

function autoFrame(b: { x0: number; y0: number; x1: number; y1: number }, marginPct: number, w: number, h: number): Crop {
  const m = (Math.max(b.x1 - b.x0, b.y1 - b.y0) * marginPct) / 100;
  const x0 = Math.max(0, b.x0 - m);
  const y0 = Math.max(0, b.y0 - m);
  const x1 = Math.min(w, b.x1 + m);
  const y1 = Math.min(h, b.y1 + m);
  return { x: x0 / w, y: y0 / h, w: (x1 - x0) / w, h: (y1 - y0) / h };
}

/** keeps a stroke small enough for the API (≤ 4000 points) without visible change */
function thin(pts: [number, number][]): [number, number][] {
  if (pts.length <= 400) return pts;
  const step = Math.ceil(pts.length / 400);
  return pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
}

export function warningLabel(code: string): string {
  const map: Record<string, string> = {
    BG_NOT_FOUND: "לא זוהה רקע ירוק",
    TOO_SMALL: "הספר לא זוהה / קטן מדי",
    NO_BACKGROUND: "אין רקע גלוי",
    TOUCHES_FRAME: "הספר נוגע בשולי הצילום",
    AMBIGUOUS_EDGE: "קצוות לא חדים",
    SPARSE_SHAPE: "צורה חריגה",
    MULTIPLE_OBJECTS: "כמה עצמים בתמונה",
  };
  return map[code] ?? code;
}
