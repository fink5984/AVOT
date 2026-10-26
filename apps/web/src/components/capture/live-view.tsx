"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Preview = HTMLVideoElement | HTMLCanvasElement | HTMLImageElement;

function intrinsicSize(el: Preview): { w: number; h: number } | null {
  if (el instanceof HTMLVideoElement) return el.videoWidth ? { w: el.videoWidth, h: el.videoHeight } : null;
  if (el instanceof HTMLCanvasElement) return { w: el.width, h: el.height };
  return el.naturalWidth ? { w: el.naturalWidth, h: el.naturalHeight } : null;
}

/**
 * Live view surface. Overlays (grid, alignment lines, focus peaking) are drawn
 * on top of the displayed image only — they are never part of the saved file.
 * Zoom/pan/rotation are CSS transforms of the preview, for focus checking and
 * convenient framing.
 */
export function LiveView({
  preview,
  grid,
  centerLines,
  zoom,
  rotation,
  peaking,
  onPeakingUnavailable,
  flashKey,
  layer,
  children,
}: {
  preview: Preview | null;
  grid: "none" | "thirds" | "fine";
  centerLines: boolean;
  zoom: number;
  rotation: number;
  peaking: boolean;
  onPeakingUnavailable: () => void;
  flashKey: number;
  /** drawn inside the rotated / zoomed layer, aligned with the picture (e.g. the processed estimate) */
  layer?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const peakCanvas = useRef<HTMLCanvasElement>(null);
  const [rect, setRect] = useState<{ w: number; h: number } | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  // mount the driver-owned element whenever the slot (re)appears or the preview changes
  const mountSlot = useCallback(
    (s: HTMLDivElement | null) => {
      slot.current = s;
      if (!s) return;
      if (preview && s.firstChild === preview) return;
      s.replaceChildren();
      if (preview) {
        preview.style.width = "100%";
        preview.style.height = "100%";
        preview.style.objectFit = "fill";
        s.appendChild(preview);
        if (preview instanceof HTMLVideoElement) void preview.play().catch(() => undefined);
      }
    },
    [preview],
  );

  // fit the frame to the image aspect inside the host (object-contain by hand,
  // so overlays line up with the picture, not with the letterbox)
  useEffect(() => {
    if (!preview || !host.current) return;
    const compute = () => {
      const size = intrinsicSize(preview);
      const box = host.current?.getBoundingClientRect();
      if (!size || !box) return;
      const swap = rotation % 180 !== 0;
      const iw = swap ? size.h : size.w;
      const ih = swap ? size.w : size.h;
      // rect = the on-screen (rotated) frame; the inner layer keeps the unrotated size
      const scale = Math.min(box.width / iw, box.height / ih);
      const w = iw * scale;
      const h = ih * scale;
      setRect((r) => (r && Math.abs(r.w - w) < 0.5 && Math.abs(r.h - h) < 0.5 ? r : { w, h }));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(host.current);
    const id = setInterval(compute, 1000); // video dimensions can change after start
    preview.addEventListener("loadedmetadata", compute);
    preview.addEventListener("load", compute);
    return () => {
      ro.disconnect();
      clearInterval(id);
      preview.removeEventListener("loadedmetadata", compute);
      preview.removeEventListener("load", compute);
    };
  }, [preview, rotation]);

  useEffect(() => {
    if (zoom === 1) setPan({ x: 0, y: 0 });
  }, [zoom]);

  // focus peaking: Sobel edge magnitude on a downscaled copy, ~8 fps
  useEffect(() => {
    if (!peaking || !preview || !peakCanvas.current) return;
    const out = peakCanvas.current;
    const work = document.createElement("canvas");
    const wctx = work.getContext("2d", { willReadFrequently: true });
    const octx = out.getContext("2d");
    if (!wctx || !octx) return;
    let raf = 0;
    let last = 0;
    let stopped = false;
    const tick = (t: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(tick);
      if (t - last < 120) return;
      last = t;
      const size = intrinsicSize(preview);
      if (!size) return;
      const W = 480;
      const H = Math.round((W * size.h) / size.w);
      if (work.width !== W || work.height !== H) {
        work.width = W;
        work.height = H;
        out.width = W;
        out.height = H;
      }
      try {
        wctx.drawImage(preview, 0, 0, W, H);
        const src = wctx.getImageData(0, 0, W, H).data;
        const lum = new Float32Array(W * H);
        for (let i = 0, p = 0; i < src.length; i += 4, p++) lum[p] = 0.299 * src[i]! + 0.587 * src[i + 1]! + 0.114 * src[i + 2]!;
        const img = octx.createImageData(W, H);
        const d = img.data;
        for (let y = 1; y < H - 1; y++) {
          for (let x = 1; x < W - 1; x++) {
            const i = y * W + x;
            const gx = -lum[i - W - 1]! - 2 * lum[i - 1]! - lum[i + W - 1]! + lum[i - W + 1]! + 2 * lum[i + 1]! + lum[i + W + 1]!;
            const gy = -lum[i - W - 1]! - 2 * lum[i - W]! - lum[i - W + 1]! + lum[i + W - 1]! + 2 * lum[i + W]! + lum[i + W + 1]!;
            if (gx * gx + gy * gy > 22000) {
              const o = i * 4;
              d[o] = 255;
              d[o + 1] = 40;
              d[o + 2] = 40;
              d[o + 3] = 230;
            }
          }
        }
        octx.putImageData(img, 0, 0);
      } catch {
        stopped = true;
        onPeakingUnavailable();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      octx.clearRect(0, 0, out.width, out.height);
    };
  }, [peaking, preview, onPeakingUnavailable]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (zoom === 1) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !rect) return;
    const limX = (rect.w * (zoom - 1)) / 2;
    const limY = (rect.h * (zoom - 1)) / 2;
    setPan({
      x: Math.max(-limX, Math.min(limX, d.px + (e.clientX - d.x))),
      y: Math.max(-limY, Math.min(limY, d.py + (e.clientY - d.y))),
    });
  };

  return (
    <div ref={host} className="checker relative flex h-full w-full items-center justify-center overflow-hidden">
      {rect && preview ? (
        <div
          ref={frame}
          className="relative shrink-0 overflow-hidden"
          style={{ width: rect.w, height: rect.h, cursor: zoom > 1 ? (drag.current ? "grabbing" : "grab") : "default" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => (drag.current = null)}
        >
          <div
            className="absolute left-1/2 top-1/2"
            style={{
              width: rotation % 180 ? rect.h : rect.w,
              height: rotation % 180 ? rect.w : rect.h,
              transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`,
              transformOrigin: "center",
            }}
          >
            <div ref={mountSlot} className="h-full w-full" />
            <canvas ref={peakCanvas} className="pointer-events-none absolute inset-0 h-full w-full" style={{ display: peaking ? "block" : "none" }} aria-hidden />
            {layer}
          </div>
          <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
            {grid === "thirds" &&
              [1, 2].map((i) => (
                <g key={i} stroke="rgba(255,255,255,0.45)" strokeWidth="1">
                  <line x1={`${(i * 100) / 3}%`} x2={`${(i * 100) / 3}%`} y1="0" y2="100%" />
                  <line y1={`${(i * 100) / 3}%`} y2={`${(i * 100) / 3}%`} x1="0" x2="100%" />
                </g>
              ))}
            {grid === "fine" &&
              Array.from({ length: 11 }, (_, i) => i + 1).map((i) => (
                <g key={i} stroke="rgba(255,255,255,0.22)" strokeWidth="1">
                  <line x1={`${(i * 100) / 12}%`} x2={`${(i * 100) / 12}%`} y1="0" y2="100%" />
                  <line y1={`${(i * 100) / 12}%`} y2={`${(i * 100) / 12}%`} x1="0" x2="100%" />
                </g>
              ))}
            {centerLines && (
              <g stroke="rgba(214,170,90,0.85)" strokeWidth="1" strokeDasharray="6 5">
                <line x1="50%" x2="50%" y1="0" y2="100%" />
                <line y1="50%" y2="50%" x1="0" x2="100%" />
              </g>
            )}
          </svg>
          {flashKey > 0 && <div key={flashKey} className="pointer-events-none absolute inset-0 bg-white" style={{ animation: "shutter-flash 220ms ease-out forwards" }} />}
        </div>
      ) : null}
      {children}
    </div>
  );
}
