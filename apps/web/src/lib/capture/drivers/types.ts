import type { CaptureStage, FileRole, PhotoCategory, ProcessingSettings } from "@avot/shared";

export type CameraKind = "WEBCAM" | "SIMULATOR" | "CANON" | "DIGICAM" | "AGENT_SIMULATOR";

export type ConnectionState = "idle" | "connecting" | "ready" | "busy" | "disconnected" | "error";

export interface CameraControl {
  id: string;
  label: string;
  type: "range" | "select" | "toggle" | "action";
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  value?: number | string | boolean;
  /** display hint, e.g. "1/125" for shutter */
  display?: string;
  readOnly?: boolean;
}

export interface CameraInfo {
  kind: CameraKind;
  name: string;
  /** resolution of the saved original, when known */
  resolution: { width: number; height: number } | null;
  battery?: number | null;
  /** extra read-only facts shown in the panel (ISO, shutter, …) */
  readouts?: { label: string; value: string }[];
  formats?: string[];
  canAutofocus: boolean;
  /** the camera's own shutter button produces captures (Canon via SDK) */
  hardwareShutter: boolean;
  /** shown as a clear notice, e.g. "simulator — not a real photo" */
  notice?: string;
}

/** The context frozen at the moment the shutter is pressed. Never re-read later. */
export interface CaptureContext {
  captureId: string;
  lotId: string;
  catalogId: string;
  category: PhotoCategory;
  lotNumber: number;
  catalogNumber: string;
  sessionId?: string;
  /** processing settings of the active profile, frozen with the shot */
  processing?: ProcessingSettings;
}

export interface CapturedFile {
  role: FileRole;
  blob: Blob;
  mimeType: string;
  filename: string;
  width?: number;
  height?: number;
}

/** Browser-stored captures return the bytes; the studio persists them to the outbox. */
export interface BrowserShot {
  kind: "browser";
  files: CapturedFile[];
  exif?: Record<string, unknown>;
}

/** Agent-stored captures: the agent owns storage + sync and reports progress via events. */
export interface AgentShot {
  kind: "agent";
  captureId: string;
}

export interface AgentCaptureUpdate {
  captureId: string;
  stage: CaptureStage;
  category?: PhotoCategory;
  lotId?: string;
  thumbUrl?: string | null;
  assetId?: string | null;
  error?: string | null;
  /** shot triggered by the camera's own shutter button */
  external?: boolean;
}

export interface DriverEvents {
  state: (s: ConnectionState, message?: string) => void;
  info: (info: CameraInfo) => void;
  controls: (controls: CameraControl[]) => void;
  "agent-capture": (u: AgentCaptureUpdate) => void;
}

export interface CameraDriver {
  readonly kind: CameraKind;
  readonly storage: "browser" | "agent";
  readonly label: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Element showing the live view (video, canvas or img). Owned by the driver. */
  previewElement(): HTMLVideoElement | HTMLCanvasElement | HTMLImageElement | null;
  info(): CameraInfo;
  controls(): CameraControl[];
  setControl(id: string, value: number | string | boolean): Promise<void>;
  capture(ctx: CaptureContext): Promise<BrowserShot | AgentShot>;
  autofocus?(): Promise<void>;
  /** keep the agent's notion of the active lot/category in sync (hardware shutter) */
  setActiveContext?(ctx: Omit<CaptureContext, "captureId">): Promise<void>;
  on<E extends keyof DriverEvents>(event: E, fn: DriverEvents[E]): () => void;
}

/** Minimal typed event emitter used by drivers. */
export class Emitter {
  private handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  on<E extends keyof DriverEvents>(event: E, fn: DriverEvents[E]): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: unknown[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: unknown[]) => void);
  }
  emit<E extends keyof DriverEvents>(event: E, ...args: Parameters<DriverEvents[E]>) {
    for (const fn of this.handlers.get(event) ?? []) fn(...args);
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e) => {
        clearTimeout(id);
        reject(e);
      },
    );
  });
}

export function timestampName(prefix: string, ext: string) {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}.${ext}`;
}
