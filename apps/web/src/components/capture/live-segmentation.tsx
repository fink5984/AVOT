"use client";

import { useEffect, useRef } from "react";
import { parseHexColor, type BgSample, type ProcessingSettings } from "@avot/shared";
import { sampleBackground, segmentBook, type SegmentResult } from "@/lib/imaging/segment";

type Preview = HTMLVideoElement | HTMLCanvasElement | HTMLImageElement;

export interface LiveSegStatus {
  /** what is actually shown: the processed picture, only the crop frame, or the plain camera image */
  effective: "processed" | "frame" | "full" | "unavailable";
  confidence: number | null;
  warnings: string[];
  ms: number;
  /** processing was too slow for the machine and was reduced to the crop frame */
  degraded: boolean;
}

/** Working widths, fastest last. The live estimate never touches the full-resolution frame. */
const TIERS = [320, 240, 176] as const;
const FRAME_MS = [110, 170, 260] as const;
const BUDGET_MS = 70;

function intrinsic(el: Preview): { w: number; h: number } | null {
  if (el instanceof HTMLVideoElement) return el.videoWidth ? { w: el.videoWidth, h: el.videoHeight } : null;
  if (el instanceof HTMLCanvasElement) return el.width ? { w: el.width, h: el.height } : null;
  return el.naturalWidth ? { w: el.naturalWidth, h: el.naturalHeight } : null;
}

/**
 * Live estimate of the finished photo, drawn on a canvas that sits in the live view's own
 * (rotated) layer: the green backdrop hidden or replaced, or just the crop frame. It works
 * on a small copy of the frame a few times per second and is only an estimate — every real
 * shot is processed again from the full-resolution original.
 */
export function LiveSegmentation({
  preview,
  settings,
  mode,
  calibrating,
  onCalibrate,
  onStatus,
}: {
  preview: Preview | null;
  settings: ProcessingSettings;
  mode: ProcessingSettings["liveMode"];
  calibrating: boolean;
  onCalibrate: (s: BgSample) => void;
  onStatus: (s: LiveSegStatus) => void;
}) {
  const out = useRef<HTMLCanvasElement>(null);
  const work = useRef<HTMLCanvasElement | null>(null);
  const settingsRef = useRef(settings);
  const modeRef = useRef(mode);
  const statusRef = useRef(onStatus);
  settingsRef.current = settings;
  modeRef.current = mode;
  statusRef.current = onStatus;

  useEffect(() => {
    const canvas = out.current;
    if (!canvas || !preview) return;
    work.current ??= document.createElement("canvas");
    const wc = work.current;
    const wctx = wc.getContext("2d", { willReadFrequently: true });
    const octx = canvas.getContext("2d");
    // the mask is computed small (fast) but the picture is drawn at display resolution (sharp)
    const fgCanvas = document.createElement("canvas");
    const fgCtx = fgCanvas.getContext("2d");
    const maskCanvas = document.createElement("canvas");
    const maskCtx = maskCanvas.getContext("2d");
    if (!wctx || !octx || !fgCtx || !maskCtx) return;
    const DISPLAY_MAX = 1280;
    const checker = document.createElement("canvas");
    checker.width = checker.height = 16;
    const cctx = checker.getContext("2d")!;
    cctx.fillStyle = "#f5f5f5";
    cctx.fillRect(0, 0, 16, 16);
    cctx.fillStyle = "#d6d6d6";
    cctx.fillRect(0, 0, 8, 8);
    cctx.fillRect(8, 8, 8, 8);
    const checkerPattern = octx.createPattern(checker, "repeat");

    let tier: number = 0;
    let degraded = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const times: number[] = [];
    let smooth: { x0: number; y0: number; x1: number; y1: number } | null = null;
    let lastReport = 0;
    let lastKey = "";

    const report = (s: LiveSegStatus) => {
      const key = `${s.effective}|${s.confidence === null ? "-" : Math.round(s.confidence * 20)}|${s.degraded}|${s.warnings.join(",")}`;
      const now = performance.now();
      if (key === lastKey && now - lastReport < 1500) return;
      lastKey = key;
      lastReport = now;
      statusRef.current(s);
    };

    const tick = () => {
      if (stopped) return;
      const m = modeRef.current;
      const s = settingsRef.current;
      const size = intrinsic(preview);
      if (m === "full" || !size || document.visibilityState !== "visible") {
        canvas.style.display = "none";
        if (m === "full") report({ effective: "full", confidence: null, warnings: [], ms: 0, degraded: false });
        timer = setTimeout(tick, 400);
        return;
      }
      const W = TIERS[tier]!;
      const H = Math.max(1, Math.round((W * size.h) / size.w));
      if (wc.width !== W || wc.height !== H) {
        wc.width = W;
        wc.height = H;
      }
      let result: SegmentResult;
      const t0 = performance.now();
      let img: ImageData;
      try {
        wctx.drawImage(preview, 0, 0, W, H);
        img = wctx.getImageData(0, 0, W, H);
        result = segmentBook({ data: img.data, width: W, height: H, channels: 4 }, { sensitivity: s.sensitivity, bgSample: s.bgSample });
      } catch {
        // tainted frame (cross-origin without CORS) or a transient decode error — show the plain camera image
        canvas.style.display = "none";
        report({ effective: "unavailable", confidence: null, warnings: [], ms: 0, degraded: false });
        timer = setTimeout(tick, 1500);
        return;
      }
      const ms = performance.now() - t0;
      times.push(ms);
      if (times.length > 6) times.shift();
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      if (times.length >= 4 && avg > BUDGET_MS) {
        times.length = 0;
        if (tier < TIERS.length - 1) tier++;
        else degraded = true; // lowest resolution is still too slow: keep only the crop frame
      }

      const showProcessed = m === "processed" && !degraded;
      const bb = result.bbox;
      if (bb) {
        const k = smooth ? 0.5 : 1;
        smooth = smooth
          ? { x0: smooth.x0 + (bb.x0 - smooth.x0) * k, y0: smooth.y0 + (bb.y0 - smooth.y0) * k, x1: smooth.x1 + (bb.x1 - smooth.x1) * k, y1: smooth.y1 + (bb.y1 - smooth.y1) * k }
          : { ...bb };
      }

      canvas.style.display = "block";
      const scale = showProcessed ? Math.max(1, Math.min(DISPLAY_MAX, size.w) / W) : 1;
      const OW = Math.round(W * scale);
      const OH = Math.round(H * scale);
      if (canvas.width !== OW || canvas.height !== OH) {
        canvas.width = OW;
        canvas.height = OH;
      } else {
        octx.clearRect(0, 0, OW, OH);
      }
      if (showProcessed) {
        const fillRgb: [number, number, number] | null = s.background === "transparent" ? null : parseHexColor(s.background);
        if (maskCanvas.width !== W || maskCanvas.height !== H) {
          maskCanvas.width = W;
          maskCanvas.height = H;
        }
        const mk = maskCtx.createImageData(W, H);
        for (let i = 0; i < result.alpha.length; i++) {
          const p = i * 4;
          mk.data[p] = mk.data[p + 1] = mk.data[p + 2] = 255;
          mk.data[p + 3] = result.alpha[i]!;
        }
        maskCtx.putImageData(mk, 0, 0);
        // sharp picture (drawn at display size) knocked out by the upscaled soft mask
        if (fgCanvas.width !== OW || fgCanvas.height !== OH) {
          fgCanvas.width = OW;
          fgCanvas.height = OH;
        }
        fgCtx.globalCompositeOperation = "source-over";
        fgCtx.imageSmoothingEnabled = true;
        fgCtx.clearRect(0, 0, OW, OH);
        fgCtx.drawImage(preview, 0, 0, OW, OH);
        fgCtx.globalCompositeOperation = "destination-in";
        fgCtx.drawImage(maskCanvas, 0, 0, W, H, 0, 0, OW, OH);
        fgCtx.globalCompositeOperation = "source-over";
        if (fillRgb) {
          octx.fillStyle = `rgb(${fillRgb[0]},${fillRgb[1]},${fillRgb[2]})`;
          octx.fillRect(0, 0, OW, OH);
        } else if (checkerPattern) {
          octx.fillStyle = checkerPattern;
          octx.fillRect(0, 0, OW, OH);
        }
        octx.imageSmoothingEnabled = true;
        octx.drawImage(fgCanvas, 0, 0);
      }
      if (smooth && (m === "frame" || degraded || showProcessed)) {
        // crop frame = book bounds + margin, exactly what Auto Crop will cut
        const mg = (Math.max(smooth.x1 - smooth.x0, smooth.y1 - smooth.y0) * s.marginPct) / 100;
        octx.lineWidth = Math.max(1.5, OW / 220);
        octx.strokeStyle = showProcessed ? "rgba(207,68,22,0.9)" : "rgba(255,255,255,0.95)";
        octx.setLineDash(s.autoCrop ? [] : [5 * scale, 4 * scale]);
        octx.strokeRect((smooth.x0 - mg) * scale, (smooth.y0 - mg) * scale, (smooth.x1 - smooth.x0 + 2 * mg) * scale, (smooth.y1 - smooth.y0 + 2 * mg) * scale);
      }

      report({
        effective: showProcessed ? "processed" : "frame",
        confidence: result.confidence,
        warnings: result.warnings,
        ms: Math.round(avg),
        degraded,
      });
      timer = setTimeout(tick, degraded ? 400 : FRAME_MS[tier]!);
    };

    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [preview]);

  const click = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!calibrating || !preview) return;
    const size = intrinsic(preview);
    const wc = work.current;
    const canvas = out.current;
    if (!size || !wc || !canvas) return;
    // sample the plain camera pixels at the clicked spot (offsetX/Y are in the canvas' own, unrotated space)
    const W = 320;
    const H = Math.max(1, Math.round((W * size.h) / size.w));
    wc.width = W;
    wc.height = H;
    const ctx = wc.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    try {
      ctx.drawImage(preview, 0, 0, W, H);
      const img = ctx.getImageData(0, 0, W, H);
      const x = (e.nativeEvent.offsetX / canvas.clientWidth) * W;
      const y = (e.nativeEvent.offsetY / canvas.clientHeight) * H;
      onCalibrate(sampleBackground({ data: img.data, width: W, height: H, channels: 4 }, x, y, 5));
    } catch {
      /* tainted canvas: calibration is unavailable for this camera */
    }
  };

  return (
    <canvas
      ref={out}
      onClick={click}
      className={calibrating ? "absolute inset-0 h-full w-full cursor-crosshair" : "pointer-events-none absolute inset-0 h-full w-full"}
      style={{ display: "none", imageRendering: "auto" }}
      aria-hidden
      data-testid="live-segmentation"
    />
  );
}
