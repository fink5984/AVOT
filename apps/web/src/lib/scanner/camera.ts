"use client";

import { createScanGate } from "./scan-gate";

/**
 * Phone-camera barcode scanning, entirely on the device: frames are decoded locally and only the decoded
 * text is ever sent anywhere. Uses the browser's BarcodeDetector where it exists (Chrome / Android) and a
 * bundled ZXing decoder everywhere else (iOS Safari, Firefox). Reads Code 128 and QR.
 */

export type CameraErrorKind = "insecure" | "unsupported" | "denied" | "nocamera" | "busy" | "error";

export class CameraError extends Error {
  constructor(
    readonly kind: CameraErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export const CAMERA_ERROR_TEXT: Record<CameraErrorKind, string> = {
  insecure: "המצלמה זמינה רק בחיבור מאובטח (https). פתחו את האתר בכתובת https.",
  unsupported: "הדפדפן אינו תומך בגישה למצלמה. אפשר להקליד את הברקוד ידנית.",
  denied: "הגישה למצלמה נחסמה. אשרו אותה בהגדרות הדפדפן (סמל המנעול ליד הכתובת) ורעננו את הדף.",
  nocamera: "לא נמצאה מצלמה במכשיר.",
  busy: "המצלמה בשימוש באפליקציה אחרת. סגרו אותה ונסו שוב.",
  error: "לא ניתן להפעיל את המצלמה.",
};

export interface CameraScanner {
  stop: () => void;
  /** "סרוק שוב": the next sighting of the code in view counts as a new scan */
  rearm: () => void;
  torchSupported: boolean;
  setTorch: (on: boolean) => Promise<boolean>;
  engine: "native" | "zxing";
}

interface DetectorLike {
  detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]>;
}

async function openStream(): Promise<MediaStream> {
  if (typeof window === "undefined" || !window.isSecureContext) throw new CameraError("insecure", CAMERA_ERROR_TEXT.insecure);
  if (!navigator.mediaDevices?.getUserMedia) throw new CameraError("unsupported", CAMERA_ERROR_TEXT.unsupported);
  try {
    // rear camera first; a laptop with only a front camera falls back to it
    return await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
  } catch (err) {
    const name = (err as DOMException).name;
    if (name === "NotAllowedError" || name === "SecurityError") throw new CameraError("denied", CAMERA_ERROR_TEXT.denied);
    if (name === "NotFoundError" || name === "OverconstrainedError") throw new CameraError("nocamera", CAMERA_ERROR_TEXT.nocamera);
    if (name === "NotReadableError" || name === "AbortError") throw new CameraError("busy", CAMERA_ERROR_TEXT.busy);
    throw new CameraError("error", CAMERA_ERROR_TEXT.error);
  }
}

async function nativeDetector(): Promise<DetectorLike | null> {
  const BD = (window as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): DetectorLike; getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector;
  if (!BD) return null;
  try {
    const supported = (await BD.getSupportedFormats?.()) ?? ["code_128", "qr_code"];
    const formats = ["code_128", "qr_code"].filter((f) => supported.includes(f));
    return formats.length ? new BD({ formats }) : null;
  } catch {
    return null;
  }
}

/** Starts the rear camera in `video` and reports each newly seen barcode through `onCode`. */
export async function startCameraScanner(video: HTMLVideoElement, onCode: (code: string) => void): Promise<CameraScanner> {
  const stream = await openStream();
  video.srcObject = stream;
  video.muted = true;
  video.setAttribute("playsinline", "true");
  await video.play().catch(() => undefined);

  const track = stream.getVideoTracks()[0]!;
  const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
  const gate = createScanGate();
  let stopped = false;
  let timer = 0;

  /** one decoded frame: every code in it (none = an empty frame, which is what releases a lock) */
  const frame = (codes: string[]) => {
    for (const code of gate.frame(codes)) onCode(code);
  };

  let decode: () => Promise<void>;
  let engine: CameraScanner["engine"] = "native";
  const native = await nativeDetector();
  if (native) {
    decode = async () => {
      const found = await native.detect(video).catch(() => []);
      frame(found.map((f) => f.rawValue));
    };
  } else {
    engine = "zxing";
    const zx = await import("@zxing/library");
    const hints = new Map<unknown, unknown>([
      [zx.DecodeHintType.POSSIBLE_FORMATS, [zx.BarcodeFormat.CODE_128, zx.BarcodeFormat.QR_CODE]],
      [zx.DecodeHintType.TRY_HARDER, true],
    ]);
    const reader = new zx.MultiFormatReader();
    reader.setHints(hints as never);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    decode = async () => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return; // no picture yet: not an empty frame
      // the central band is where the worker aims; a smaller image decodes faster
      const cw = Math.min(w, 960);
      const ch = Math.round(cw * (h / w));
      canvas.width = cw;
      canvas.height = ch;
      ctx.drawImage(video, 0, 0, cw, ch);
      try {
        const bitmap = new zx.BinaryBitmap(new zx.HybridBinarizer(new zx.HTMLCanvasElementLuminanceSource(canvas)));
        frame([reader.decode(bitmap).getText()]);
      } catch {
        frame([]); // no barcode in this frame (NotFoundException)
      }
    };
  }

  const interval = engine === "native" ? 110 : 160;
  const loop = async () => {
    if (stopped) return;
    if (!document.hidden && video.readyState >= 2) await decode().catch(() => undefined);
    if (!stopped) timer = window.setTimeout(loop, interval);
  };
  timer = window.setTimeout(loop, interval);

  return {
    engine,
    rearm: () => gate.rearm(),
    torchSupported: !!caps.torch,
    async setTorch(on) {
      try {
        await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
        return on;
      } catch {
        return false;
      }
    },
    stop() {
      stopped = true;
      window.clearTimeout(timer);
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}
