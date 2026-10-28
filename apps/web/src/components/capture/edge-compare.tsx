"use client";

import { useEffect, useRef, useState } from "react";
import { parseHexColor, type ProcessingSettings } from "@avot/shared";
import { composeOutputSteps, refineAlphaSteps } from "@/lib/imaging/compose";
import { runAsync } from "@/lib/imaging/raster";
import type { SegmentResult } from "@/lib/imaging/segment";
import { cn } from "@/lib/cn";

const LONG_EDGE = 2400;

/** bilinear resize of a one-channel map through the browser's canvas */
function resizeMap(map: Uint8Array, w: number, h: number, toW: number, toH: number): Uint8Array {
  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  const sctx = small.getContext("2d")!;
  const img = sctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = map[i]!;
    img.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  const big = document.createElement("canvas");
  big.width = toW;
  big.height = toH;
  const bctx = big.getContext("2d", { willReadFrequently: true })!;
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = "high";
  bctx.drawImage(small, 0, 0, toW, toH);
  const d = bctx.getImageData(0, 0, toW, toH).data;
  const out = new Uint8Array(toW * toH);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4]!;
  return out;
}

/**
 * Before / after of the cut-out at the photo's own pixels. The original is on one side of the divider and the cut-out
 * (the same matte the server applies — `refineAlpha` / `composeOutput` run here on a larger copy) on the other, so
 * "100%" shows the real edge. Only a preview: saving still re-processes the untouched original on the server.
 */
export function EdgeCompare({
  assetId,
  settings,
  result,
  workW,
  workH,
}: {
  assetId: string;
  settings: ProcessingSettings;
  result: SegmentResult | null;
  workW: number;
  workH: number;
}) {
  const [src, setSrc] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [after, setAfter] = useState<HTMLCanvasElement | null>(null);
  const [split, setSplit] = useState(50);
  const [zoom100, setZoom100] = useState(false);
  const [busy, setBusy] = useState(false);
  const beforeRef = useRef<HTMLCanvasElement>(null);
  const afterRef = useRef<HTMLCanvasElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const focus = useRef<{ x: number; y: number }>({ x: 0.5, y: 0.5 });

  useEffect(() => {
    setSrc(null);
    setError(null);
    const el = new Image();
    el.onload = () => setSrc(el);
    el.onerror = () => setError("לא ניתן לטעון את התמונה להשוואה");
    el.src = `/api/assets/${assetId}/edit-source?rotation=${settings.rotation}&long=${LONG_EDGE}`;
  }, [assetId, settings.rotation]);

  // the "after": coarse mask → full matte on this copy → composed over the chosen background
  useEffect(() => {
    if (!src || !result) return;
    let cancelled = false;
    setBusy(true);
    (async () => {
      const W = src.naturalWidth;
      const H = src.naturalHeight;
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(src, 0, 0);
      const rgba = ctx.getImageData(0, 0, W, H);
      const img = { rgb: rgba.data as unknown as Uint8Array, width: W, height: H, channels: 4 as const };
      const alphaUp = resizeMap(result.alpha, workW, workH, W, H);
      const edgeUp = resizeMap(result.edge, workW, workH, W, H);
      const forcedUp = result.forced.some((v) => v) ? resizeMap(result.forced, workW, workH, W, H) : null;
      const tick = () => new Promise<void>((r) => setTimeout(r, 0));
      const alpha = await runAsync(refineAlphaSteps(img, alphaUp, forcedUp, result.model, { edge: edgeUp, quality: settings.edgeQuality }), tick);
      if (cancelled) return;
      const bg = settings.background === "transparent" ? null : parseHexColor(settings.background);
      const out = await runAsync(
        composeOutputSteps({ ...img, alpha, edge: edgeUp, model: result.model, background: bg, crop: { x: 0, y: 0, w: W, h: H }, quality: settings.edgeQuality }),
        tick,
      );
      if (cancelled) return;
      const oc = document.createElement("canvas");
      oc.width = W;
      oc.height = H;
      const octx = oc.getContext("2d")!;
      const o = octx.createImageData(W, H);
      for (let i = 0; i < W * H; i++) {
        o.data[i * 4] = out.data[i * out.channels]!;
        o.data[i * 4 + 1] = out.data[i * out.channels + 1]!;
        o.data[i * 4 + 2] = out.data[i * out.channels + 2]!;
        o.data[i * 4 + 3] = out.channels === 4 ? out.data[i * 4 + 3]! : 255;
      }
      octx.putImageData(o, 0, 0);
      setAfter(oc);
      setBusy(false);
    })().catch(() => {
      if (!cancelled) {
        setError("ההשוואה נכשלה");
        setBusy(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [src, result, workW, workH, settings.edgeQuality, settings.background]);

  useEffect(() => {
    if (!src || !beforeRef.current) return;
    beforeRef.current.width = src.naturalWidth;
    beforeRef.current.height = src.naturalHeight;
    beforeRef.current.getContext("2d")!.drawImage(src, 0, 0);
  }, [src]);
  useEffect(() => {
    if (!after || !afterRef.current) return;
    afterRef.current.width = after.width;
    afterRef.current.height = after.height;
    afterRef.current.getContext("2d")!.drawImage(after, 0, 0);
  }, [after]);

  // entering 100%: scroll so the point that was under the divider stays in view
  useEffect(() => {
    const s = scroller.current;
    if (!s || !src) return;
    if (zoom100) {
      s.scrollLeft = focus.current.x * s.scrollWidth - s.clientWidth / 2;
      s.scrollTop = focus.current.y * s.scrollHeight - s.clientHeight / 2;
    } else {
      s.scrollLeft = 0;
      s.scrollTop = 0;
    }
  }, [zoom100, src]);

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    focus.current = { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, y)) };
    if (e.buttons === 1) setSplit(Math.min(100, Math.max(0, x * 100)));
  };

  return (
    <div className="space-y-2" data-testid="edge-compare">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
        <span>גררו את הקו: מימין המקור, משמאל החיתוך</span>
        <button
          type="button"
          onClick={() => setZoom100((z) => !z)}
          aria-pressed={zoom100}
          className={cn("ms-auto rounded-md border border-line px-2.5 py-1 text-[12.5px]", zoom100 ? "bg-ink text-paper" : "bg-paper text-ink")}
        >
          {zoom100 ? "התאמה למסך" : "זום 100%"}
        </button>
        {src && <span className="num">{src.naturalWidth}×{src.naturalHeight}</span>}
      </div>
      <div ref={scroller} className={cn("checker relative max-h-[56vh] min-h-[240px] overflow-auto rounded-lg bg-stone", !zoom100 && "flex items-center justify-center")} dir="ltr">
        {error ? (
          <p className="p-8 text-danger">{error}</p>
        ) : !src || !after ? (
          <p className="p-8 text-muted">{busy || !src ? "מחשב את החיתוך…" : "טוען…"}</p>
        ) : (
          <div
            className={cn("relative select-none touch-none", zoom100 ? "w-max" : "max-h-[56vh] max-w-full")}
            style={zoom100 ? undefined : { aspectRatio: `${src.naturalWidth} / ${src.naturalHeight}`, maxHeight: "56vh" }}
            onPointerDown={(e) => {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              const r = e.currentTarget.getBoundingClientRect();
              setSplit(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)));
            }}
            onPointerMove={move}
          >
            <canvas ref={afterRef} className={zoom100 ? "block" : "block h-full w-full"} aria-label="אחרי: החיתוך" />
            <canvas
              ref={beforeRef}
              className={cn("absolute left-0 top-0", zoom100 ? "block" : "block h-full w-full")}
              style={{ clipPath: `inset(0 0 0 ${split}%)` }}
              aria-label="לפני: המקור"
            />
            <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]" style={{ left: `${split}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}
