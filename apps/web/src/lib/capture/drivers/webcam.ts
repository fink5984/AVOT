"use client";

import {
  Emitter,
  timestampName,
  withTimeout,
  type BrowserShot,
  type CameraControl,
  type CameraDriver,
  type CameraInfo,
  type ConnectionState,
} from "./types";

// ImageCapture is not in TypeScript's DOM lib yet
interface PhotoCapabilities {
  imageWidth?: { min: number; max: number; step: number };
  imageHeight?: { min: number; max: number; step: number };
}
interface ImageCaptureLike {
  takePhoto(settings?: { imageWidth?: number; imageHeight?: number }): Promise<Blob>;
  getPhotoCapabilities(): Promise<PhotoCapabilities>;
}
declare const ImageCapture: { new (track: MediaStreamTrack): ImageCaptureLike } | undefined;

type ExtCaps = MediaTrackCapabilities & Record<string, unknown>;

/** Track constraints we expose when the device reports support for them. */
const CONTROL_DEFS: { id: string; label: string; kind: "range" | "mode" | "toggle" }[] = [
  { id: "zoom", label: "זום (מצלמה)", kind: "range" },
  { id: "focusMode", label: "מצב פוקוס", kind: "mode" },
  { id: "focusDistance", label: "מרחק פוקוס", kind: "range" },
  { id: "exposureMode", label: "מצב חשיפה", kind: "mode" },
  { id: "exposureCompensation", label: "פיצוי חשיפה", kind: "range" },
  { id: "exposureTime", label: "זמן חשיפה", kind: "range" },
  { id: "whiteBalanceMode", label: "איזון לבן", kind: "mode" },
  { id: "colorTemperature", label: "טמפרטורת צבע", kind: "range" },
  { id: "brightness", label: "בהירות", kind: "range" },
  { id: "contrast", label: "ניגודיות", kind: "range" },
  { id: "sharpness", label: "חדות (עיבוד)", kind: "range" },
  { id: "torch", label: "פנס", kind: "toggle" },
];

const MODE_LABEL: Record<string, string> = {
  continuous: "רציף (אוטומטי)",
  "single-shot": "חד-פעמי",
  manual: "ידני",
  none: "ללא",
};

export async function listWebcams(): Promise<{ deviceId: string; label: string }[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  let devices = await navigator.mediaDevices.enumerateDevices();
  // labels are empty until camera permission was granted once
  if (devices.some((d) => d.kind === "videoinput" && !d.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      s.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      /* permission denied — return what we have */
    }
  }
  return devices
    .filter((d) => d.kind === "videoinput")
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `מצלמה ${i + 1}` }));
}

/**
 * Any camera Windows exposes as a webcam (USB webcam, a phone via Phone Link /
 * DroidCam / Camo, virtual cameras). Captures the highest resolution the device
 * offers: ImageCapture.takePhoto() at the max photo size when the browser and
 * device support it, otherwise a lossless-quality frame from the video track.
 */
export class WebcamDriver extends Emitter implements CameraDriver {
  readonly kind = "WEBCAM" as const;
  readonly storage = "browser" as const;
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private video: HTMLVideoElement | null = null;
  private imageCapture: ImageCaptureLike | null = null;
  private photoCaps: PhotoCapabilities | null = null;
  private state: ConnectionState = "idle";
  private photoMode: "takePhoto" | "frame" = "frame";

  constructor(
    public deviceId: string,
    readonly label: string,
  ) {
    super();
  }

  private setState(s: ConnectionState, msg?: string) {
    this.state = s;
    this.emit("state", s, msg);
  }

  async connect() {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.setState("error", "הדפדפן אינו מאפשר גישה למצלמה בחיבור זה. יש לעבוד דרך HTTPS או localhost.");
      throw new Error("getUserMedia unavailable");
    }
    this.setState("connecting");
    const open = (deviceId: string) =>
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { deviceId: { exact: deviceId }, width: { ideal: 4096 }, height: { ideal: 3072 }, frameRate: { ideal: 30, max: 30 } },
      });
    try {
      try {
        this.stream = await open(this.deviceId);
      } catch (first) {
        // device ids may be re-issued (new browser session, re-plugged camera): find the same camera by its label
        const name = (first as DOMException).name;
        if (name !== "OverconstrainedError" && name !== "NotFoundError") throw first;
        const match = (await listWebcams()).find((d) => d.label === this.label);
        if (!match || match.deviceId === this.deviceId) throw first;
        this.deviceId = match.deviceId;
        this.stream = await open(match.deviceId);
      }
    } catch (err) {
      const name = (err as DOMException).name;
      const msg =
        name === "NotAllowedError"
          ? "הגישה למצלמה נחסמה. אשרו גישה למצלמה בהגדרות הדפדפן."
          : name === "NotReadableError"
            ? "המצלמה תפוסה על ידי תוכנה אחרת (Zoom, Teams, אפליקציית מצלמה…). סגרו אותה ונסו שוב."
            : name === "OverconstrainedError" || name === "NotFoundError"
              ? "המצלמה שנבחרה לא נמצאה. ייתכן שנותקה."
              : "החיבור למצלמה נכשל.";
      this.setState("error", msg);
      throw err;
    }
    this.track = this.stream.getVideoTracks()[0] ?? null;
    if (!this.track) {
      this.setState("error", "לא התקבל ערוץ וידאו מהמצלמה");
      throw new Error("no video track");
    }
    this.track.addEventListener("ended", () => this.setState("disconnected", "המצלמה נותקה. חברו אותה מחדש ולחצו ״חיבור מחדש״."));

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = this.stream;
    video.className = "block h-full w-full object-contain";
    this.video = video;
    await withTimeout(
      new Promise<void>((resolve) => {
        if (video.readyState >= 2) resolve();
        else video.onloadeddata = () => resolve();
      }),
      8000,
      "המצלמה לא שלחה תמונה",
    );
    await video.play().catch(() => undefined);

    if (typeof ImageCapture !== "undefined") {
      try {
        this.imageCapture = new ImageCapture(this.track);
        this.photoCaps = await withTimeout(this.imageCapture.getPhotoCapabilities(), 3000, "timeout");
        const maxW = this.photoCaps.imageWidth?.max ?? 0;
        if (maxW > video.videoWidth) this.photoMode = "takePhoto";
      } catch {
        this.imageCapture = null;
      }
    }
    this.setState("ready");
    this.emit("info", this.info());
    this.emit("controls", this.controls());
  }

  async disconnect() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
    this.setState("idle");
  }

  previewElement() {
    return this.video;
  }

  info(): CameraInfo {
    const v = this.video;
    const res =
      this.photoMode === "takePhoto" && this.photoCaps?.imageWidth && this.photoCaps.imageHeight
        ? { width: this.photoCaps.imageWidth.max, height: this.photoCaps.imageHeight.max }
        : v && v.videoWidth
          ? { width: v.videoWidth, height: v.videoHeight }
          : null;
    return {
      kind: "WEBCAM",
      name: this.label,
      resolution: res,
      canAutofocus: this.supports("focusMode", "single-shot"),
      hardwareShutter: false,
      formats: ["JPEG"],
      readouts: [{ label: "שיטת צילום", value: this.photoMode === "takePhoto" ? "צילום סטילס (ImageCapture)" : "פריים מזרם הווידאו" }],
    };
  }

  private caps(): ExtCaps {
    try {
      return (this.track?.getCapabilities?.() ?? {}) as ExtCaps;
    } catch {
      return {} as ExtCaps;
    }
  }

  private supports(id: string, mode?: string) {
    const c = this.caps()[id];
    if (!c) return false;
    return mode ? Array.isArray(c) && (c as string[]).includes(mode) : true;
  }

  controls(): CameraControl[] {
    if (!this.track) return [];
    const caps = this.caps();
    const settings = this.track.getSettings() as Record<string, unknown>;
    const out: CameraControl[] = [];
    for (const def of CONTROL_DEFS) {
      const c = caps[def.id];
      if (c === undefined) continue;
      if (def.kind === "range" && typeof c === "object" && c && "max" in c) {
        const r = c as { min: number; max: number; step?: number };
        if (r.max <= r.min) continue;
        out.push({ id: def.id, label: def.label, type: "range", min: r.min, max: r.max, step: r.step || (r.max - r.min) / 100, value: settings[def.id] as number });
      } else if (def.kind === "mode" && Array.isArray(c) && c.length > 1) {
        out.push({
          id: def.id,
          label: def.label,
          type: "select",
          options: (c as string[]).map((m) => ({ value: m, label: MODE_LABEL[m] ?? m })),
          value: settings[def.id] as string,
        });
      } else if (def.kind === "toggle" && (c === true || (Array.isArray(c) && c.includes(true)))) {
        out.push({ id: def.id, label: def.label, type: "toggle", value: !!settings[def.id] });
      }
    }
    return out;
  }

  async setControl(id: string, value: number | string | boolean) {
    if (!this.track) return;
    await this.track.applyConstraints({ advanced: [{ [id]: value } as MediaTrackConstraintSet] });
    this.emit("controls", this.controls());
  }

  async autofocus() {
    if (this.supports("focusMode", "single-shot")) await this.setControl("focusMode", "single-shot");
  }

  async capture(): Promise<BrowserShot> {
    const v = this.video;
    if (!v || !this.track || this.track.readyState !== "live") throw new Error("המצלמה אינה מחוברת");
    let blob: Blob | null = null;
    let method = "frame";
    if (this.photoMode === "takePhoto" && this.imageCapture && this.photoCaps?.imageWidth && this.photoCaps.imageHeight) {
      try {
        blob = await withTimeout(
          this.imageCapture.takePhoto({ imageWidth: this.photoCaps.imageWidth.max, imageHeight: this.photoCaps.imageHeight.max }),
          10_000,
          "takePhoto timeout",
        );
        method = "takePhoto";
      } catch {
        blob = null; // some drivers refuse stills; fall back to a frame
      }
    }
    if (!blob) {
      const w = v.videoWidth;
      const h = v.videoHeight;
      if (!w || !h) throw new Error("לא התקבלה תמונה מהמצלמה");
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("Canvas unavailable");
      ctx.drawImage(v, 0, 0, w, h);
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
    }
    if (!blob || blob.size < 2048) throw new Error("התמונה שהתקבלה ריקה או פגומה");

    let width: number | undefined;
    let height: number | undefined;
    try {
      const bmp = await createImageBitmap(blob);
      width = bmp.width;
      height = bmp.height;
      bmp.close();
    } catch {
      throw new Error("התמונה שהתקבלה אינה קובץ תמונה תקין");
    }
    const mime = blob.type || "image/jpeg";
    const ext = mime === "image/png" ? "png" : "jpg";
    const settings = this.track.getSettings();
    return {
      kind: "browser",
      files: [{ role: "PRIMARY", blob, mimeType: mime, filename: timestampName("webcam", ext), width, height }],
      exif: {
        camera: this.label,
        method,
        videoWidth: settings.width,
        videoHeight: settings.height,
        frameRate: settings.frameRate,
        userAgent: navigator.userAgent,
      },
    };
  }
}
