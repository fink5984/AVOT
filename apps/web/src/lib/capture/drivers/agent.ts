"use client";

import type { CaptureStage, PhotoCategory } from "@avot/shared";
import { Emitter, type AgentShot, type CameraControl, type CameraDriver, type CameraInfo, type CaptureContext } from "./types";

export const DEFAULT_AGENT_URL = "http://127.0.0.1:47800";

export interface AgentHello {
  product: "avot-capture-agent";
  version: string;
  apiVersion: number;
  paired: boolean;
  deviceId: string | null;
  deviceName: string | null;
  serverOrigin: string | null;
  camera: { kind: "CANON" | "DIGICAM" | "SIMULATOR" | "NONE"; model: string | null; connected: boolean };
}

/** Probes the local Capture Agent. Returns null when it is not installed/running. */
export async function probeAgent(baseUrl = DEFAULT_AGENT_URL): Promise<AgentHello | null> {
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), 1200);
    const res = await fetch(`${baseUrl}/v1/hello`, { signal: ctrl.signal, mode: "cors", cache: "no-store" });
    clearTimeout(id);
    if (!res.ok) return null;
    const data = (await res.json()) as AgentHello;
    return data.product === "avot-capture-agent" ? data : null;
  } catch {
    return null;
  }
}

interface AgentStatus {
  camera: {
    kind: "CANON" | "DIGICAM" | "SIMULATOR" | "NONE";
    model: string | null;
    connected: boolean;
    busy: boolean;
    battery: number | null;
    liveView: boolean;
    resolution: { width: number; height: number } | null;
    formats: string[];
    canAutofocus: boolean;
    hardwareShutter: boolean;
    controls: CameraControl[];
    readouts: { label: string; value: string }[];
    lastError: string | null;
  };
  queue: { pending: number; failed: number; lastSyncAt: string | null };
  disk: { freeBytes: number; level: "ok" | "low" | "critical" };
}

interface AgentEvent {
  seq: number;
  type: "capture" | "camera";
  captureId?: string;
  stage?: CaptureStage;
  lotId?: string;
  category?: PhotoCategory;
  error?: string | null;
  external?: boolean;
  hasThumb?: boolean;
  assetId?: string | null;
}

/**
 * Drives a camera attached to this PC through the Windows Capture Agent on
 * 127.0.0.1. The agent owns the camera session (Canon EDSDK or its own
 * simulator), writes originals to local disk before acknowledging, and syncs
 * them to the cloud itself. The browser only shows live view and status.
 */
export class AgentDriver extends Emitter implements CameraDriver {
  readonly kind: "CANON" | "DIGICAM" | "AGENT_SIMULATOR";
  readonly storage = "agent" as const;
  private lease: string | null = null;
  private token: string | null = null;
  private cursor = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private img: HTMLImageElement | null = null;
  private status: AgentStatus | null = null;
  private failures = 0;

  constructor(
    readonly baseUrl: string,
    readonly deviceId: string,
    readonly label: string,
    cameraKind: "CANON" | "DIGICAM" | "SIMULATOR" | "NONE",
    private readonly getToken: () => Promise<string>,
  ) {
    super();
    this.kind = cameraKind === "SIMULATOR" ? "AGENT_SIMULATOR" : cameraKind === "DIGICAM" ? "DIGICAM" : "CANON";
  }

  private headers(json = false): HeadersInit {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      authorization: `Bearer ${this.token}`,
      "x-avot-lease": this.lease ?? "",
    };
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, mode: "cors", cache: "no-store" });
    const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) {
      const err = new Error(data?.error?.message ?? `Capture Agent: HTTP ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return data as T;
  }

  async connect() {
    this.emit("state", "connecting");
    try {
      this.token = await this.getToken();
      const r = await this.call<{ leaseId: string }>("/v1/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: this.token }),
      });
      this.lease = r.leaseId;
    } catch (err) {
      const e = err as Error & { status?: number };
      this.emit(
        "state",
        "error",
        e.status === 409 ? e.message : e.status === 403 ? `העמדה דחתה את החיבור: ${e.message}` : "לא ניתן להתחבר ל-Capture Agent במחשב זה.",
      );
      throw err;
    }
    await this.refreshStatus();
    const ev = await this.call<{ cursor: number }>("/v1/events?since=-1", { headers: this.headers() });
    this.cursor = ev.cursor;
    this.pollTimer = setInterval(() => void this.poll(), 500);
  }

  private async refreshStatus() {
    const s = await this.call<AgentStatus>("/v1/status", { headers: this.headers() });
    this.status = s;
    this.emit("info", this.info());
    this.emit("controls", s.camera.controls);
    if (!s.camera.connected) this.emit("state", "disconnected", s.camera.lastError ?? "המצלמה אינה מחוברת לעמדה. חברו אותה בכבל USB והדליקו אותה.");
    else this.emit("state", s.camera.busy ? "busy" : "ready");
    if (s.camera.connected && !this.img) this.ensureLiveView();
  }

  private ensureLiveView() {
    const img = this.img ?? document.createElement("img");
    img.className = "block h-full w-full object-contain";
    img.alt = "";
    img.crossOrigin = "anonymous";
    img.src = `${this.baseUrl}/v1/liveview.mjpg?k=${encodeURIComponent(this.lease ?? "")}&t=${Date.now()}`;
    img.onerror = () => setTimeout(() => this.status?.camera.connected && this.ensureLiveView(), 1500);
    this.img = img;
  }

  private async poll() {
    try {
      const r = await this.call<{ cursor: number; events: AgentEvent[] }>(`/v1/events?since=${this.cursor}`, { headers: this.headers() });
      this.failures = 0;
      this.cursor = r.cursor;
      let cameraChanged = false;
      for (const e of r.events) {
        if (e.type === "camera") cameraChanged = true;
        if (e.type === "capture" && e.captureId && e.stage) {
          this.emit("agent-capture", {
            captureId: e.captureId,
            stage: e.stage,
            category: e.category,
            lotId: e.lotId,
            error: e.error ?? null,
            external: e.external,
            assetId: e.assetId ?? null,
            thumbUrl: e.hasThumb ? `${this.baseUrl}/v1/captures/${e.captureId}/thumb?k=${encodeURIComponent(this.lease ?? "")}` : null,
          });
        }
      }
      if (cameraChanged || r.events.length === 0) await this.refreshStatus();
    } catch (err) {
      this.failures++;
      const status = (err as { status?: number }).status;
      if (status === 409) {
        // another tab of this user took over the camera — do not fight over it
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
        this.emit("state", "disconnected", (err as Error).message);
      } else if (status === 401 && this.failures === 1) {
        // lease lost (agent restarted / another tab took over) — reconnect transparently
        await this.reconnectLease().catch(() => undefined);
      } else if (this.failures >= 4) {
        this.emit("state", "disconnected", "אין תקשורת עם Capture Agent. ודאו שהתוכנה פועלת (סמל במגש המערכת).");
      }
    }
  }

  private async reconnectLease() {
    this.token = await this.getToken();
    const r = await this.call<{ leaseId: string }>("/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: this.token }),
    });
    this.lease = r.leaseId;
    this.img = null;
  }

  async disconnect() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.img) this.img.src = "";
    this.img = null;
    if (this.lease) await this.call("/v1/release", { method: "POST", headers: this.headers() }).catch(() => undefined);
    this.lease = null;
    this.emit("state", "idle");
  }

  previewElement() {
    return this.img;
  }

  info(): CameraInfo {
    const c = this.status?.camera;
    return {
      kind: this.kind,
      name: c?.model ?? this.label,
      resolution: c?.resolution ?? null,
      battery: c?.battery ?? null,
      readouts: c?.readouts ?? [],
      formats: c?.formats ?? [],
      canAutofocus: c?.canAutofocus ?? false,
      hardwareShutter: c?.hardwareShutter ?? false,
      notice: this.kind === "AGENT_SIMULATOR" ? "סימולטור של Capture Agent — קבצי בדיקה מסומנים, לא צילום אמיתי" : undefined,
    };
  }

  queueStatus() {
    return this.status ? { ...this.status.queue, disk: this.status.disk } : null;
  }

  controls(): CameraControl[] {
    return this.status?.camera.controls ?? [];
  }

  async setControl(id: string, value: number | string | boolean) {
    await this.call("/v1/settings", { method: "POST", headers: this.headers(true), body: JSON.stringify({ id, value }) });
    await this.refreshStatus();
  }

  async autofocus() {
    await this.call("/v1/autofocus", { method: "POST", headers: this.headers() });
  }

  async setActiveContext(ctx: Omit<CaptureContext, "captureId">) {
    await this.call("/v1/context", { method: "POST", headers: this.headers(true), body: JSON.stringify(ctx) });
  }

  /** Resolves when the agent accepted the shutter command; storage progress arrives as events. */
  async capture(ctx: CaptureContext): Promise<AgentShot> {
    await this.call("/v1/capture", { method: "POST", headers: this.headers(true), body: JSON.stringify(ctx) });
    return { kind: "agent", captureId: ctx.captureId };
  }
}
