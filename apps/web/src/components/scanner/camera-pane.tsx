"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Flashlight, FlashlightOff } from "lucide-react";
import { CAMERA_ERROR_TEXT, CameraError, startCameraScanner, type CameraScanner } from "@/lib/scanner/camera";
import { cn } from "@/lib/cn";

/**
 * The phone's rear camera as a barcode scanner. It stays open the whole time the worker is scanning in a
 * row, so shelf → book → book → book never reopens the camera. Nothing from the video leaves the device.
 */
export function CameraPane({ onCode, enabled, className }: { onCode: (code: string) => void; enabled: boolean; className?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const scanner = useRef<CameraScanner | null>(null);
  const handler = useRef(onCode);
  handler.current = onCode;
  const [state, setState] = useState<"idle" | "starting" | "on" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [torch, setTorch] = useState(false);
  const [torchOk, setTorchOk] = useState(false);
  const [flash, setFlash] = useState(0);
  const [last, setLast] = useState<string | null>(null);

  async function start() {
    if (!video.current || scanner.current) return;
    setState("starting");
    setError(null);
    try {
      const s = await startCameraScanner(video.current, (c) => {
        setFlash((n) => n + 1);
        setLast(c);
        handler.current(c);
      });
      scanner.current = s;
      setTorchOk(s.torchSupported);
      setState("on");
    } catch (err) {
      setState("error");
      setError(err instanceof CameraError ? err.message : CAMERA_ERROR_TEXT.error);
    }
  }
  function stop() {
    scanner.current?.stop();
    scanner.current = null;
    setTorch(false);
    setState("idle");
  }

  useEffect(() => {
    if (enabled) void start();
    else stop();
    return stop;
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // a hidden tab / locked phone releases the camera and takes it back when the worker returns
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) stop();
      else if (enabled) void start();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={cn("relative overflow-hidden rounded-xl bg-black ring-1 ring-rule", className)} data-testid="camera-pane" data-state={state}>
      <video ref={video} className={cn("h-full w-full object-cover", state !== "on" && "invisible")} playsInline muted aria-label="תצוגת המצלמה" />
      {state === "on" && (
        <>
          <div className="pointer-events-none absolute inset-x-[10%] top-1/2 h-[34%] -translate-y-1/2 rounded-lg border-2 border-white/70 shadow-[0_0_0_9999px_rgb(0_0_0/0.35)]" aria-hidden />
          <div key={flash} className="pointer-events-none absolute inset-0 bg-white/35" aria-hidden style={{ opacity: 0, animation: flash ? "scanflash 300ms ease-out" : undefined }} />
        </>
      )}
      {state !== "on" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-[13.5px]">
          {state === "starting" ? (
            <>
              <Camera className="size-7 animate-pulse text-white/70" />
              <span className="text-white/80">פותח מצלמה…</span>
            </>
          ) : (
            <>
              <CameraOff className="size-7 text-white/60" />
              <span className="max-w-xs text-white/80">{error ?? "המצלמה כבויה"}</span>
              {state === "error" || state === "idle" ? (
                <button type="button" onClick={() => void start()} className="mt-1 h-10 rounded-lg bg-white px-4 text-[14px] font-semibold text-black">
                  הפעלת מצלמה
                </button>
              ) : null}
            </>
          )}
        </div>
      )}
      {state === "on" && last && (
        <button
          type="button"
          onClick={() => {
            scanner.current?.rearm();
            setLast(null);
          }}
          className="absolute bottom-2 start-2 h-11 rounded-full bg-black/60 px-4 text-[13.5px] font-semibold text-white"
        >
          סרוק שוב
        </button>
      )}
      {state === "on" && torchOk && (
        <button
          type="button"
          onClick={async () => setTorch(await (scanner.current?.setTorch(!torch) ?? false))}
          aria-pressed={torch}
          aria-label="פנס"
          className={cn("absolute bottom-2 end-2 flex size-11 items-center justify-center rounded-full", torch ? "bg-white text-black" : "bg-black/55 text-white")}
        >
          {torch ? <Flashlight className="size-5" /> : <FlashlightOff className="size-5" />}
        </button>
      )}
      <style>{`@keyframes scanflash { 0% { opacity: 1 } 100% { opacity: 0 } }`}</style>
    </div>
  );
}
