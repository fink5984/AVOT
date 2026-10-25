"use client";

import { Emitter, timestampName, type BrowserShot, type CameraControl, type CameraDriver, type CameraInfo, type CaptureContext } from "./types";

const W = 4000;
const H = 3000;

/**
 * Development / test camera. Renders a synthetic "book page" test chart and
 * produces real JPEG files clearly watermarked SIMULATOR, so they can never be
 * mistaken for photographs. Supports failure injection for testing the error
 * paths (failed capture, disconnect, slow capture).
 * Available only in development or to administrators when enabled.
 */
export class SimulatorDriver extends Emitter implements CameraDriver {
  readonly kind = "SIMULATOR" as const;
  readonly storage = "browser" as const;
  readonly label = "סימולטור מצלמה";
  private canvas: HTMLCanvasElement | null = null;
  private raf = 0;
  private failNext = false;
  private latencyMs = 150;
  private frame = 0;
  private connected = false;

  async connect() {
    this.emit("state", "connecting");
    const c = document.createElement("canvas");
    c.width = 1200;
    c.height = 900;
    c.className = "block h-full w-full object-contain";
    this.canvas = c;
    this.connected = true;
    const loop = () => {
      this.frame++;
      if (this.frame % 2 === 0) this.paint(c, 1200, 900, null);
      this.raf = requestAnimationFrame(loop);
    };
    loop();
    this.emit("state", "ready");
    this.emit("info", this.info());
    this.emit("controls", this.controls());
  }

  async disconnect() {
    cancelAnimationFrame(this.raf);
    this.connected = false;
    this.canvas = null;
    this.emit("state", "idle");
  }

  previewElement() {
    return this.canvas;
  }

  info(): CameraInfo {
    return {
      kind: "SIMULATOR",
      name: "סימולטור מצלמה",
      resolution: { width: W, height: H },
      canAutofocus: true,
      hardwareShutter: false,
      formats: ["JPEG"],
      notice: "מצב סימולטור — הקבצים הם תמונות בדיקה מסומנות ואינם צילום אמיתי",
    };
  }

  controls(): CameraControl[] {
    return [
      { id: "failNext", label: "כשל בצילום הבא", type: "toggle", value: this.failNext },
      {
        id: "latency",
        label: "השהיית צילום",
        type: "select",
        value: String(this.latencyMs),
        options: [
          { value: "150", label: "מהירה (150ms)" },
          { value: "1200", label: "איטית (1.2s)" },
          { value: "4000", label: "איטית מאוד (4s)" },
        ],
      },
      { id: "disconnect", label: "הדמיית ניתוק", type: "action" },
    ];
  }

  async setControl(id: string, value: number | string | boolean) {
    if (id === "failNext") this.failNext = !!value;
    if (id === "latency") this.latencyMs = Number(value);
    if (id === "disconnect") {
      cancelAnimationFrame(this.raf);
      this.connected = false;
      this.emit("state", "disconnected", "הסימולטור נותק (הדמיה). לחצו ״חיבור מחדש״.");
      return;
    }
    this.emit("controls", this.controls());
  }

  async autofocus() {
    await new Promise((r) => setTimeout(r, 200));
  }

  async capture(ctx: CaptureContext): Promise<BrowserShot> {
    if (!this.connected) throw new Error("הסימולטור אינו מחובר");
    await new Promise((r) => setTimeout(r, this.latencyMs));
    if (this.failNext) {
      this.failNext = false;
      this.emit("controls", this.controls());
      throw new Error("כשל מדומה בצילום (סימולטור)");
    }
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    this.paint(canvas, W, H, ctx);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) throw new Error("יצירת קובץ הבדיקה נכשלה");
    return {
      kind: "browser",
      files: [{ role: "PRIMARY", blob, mimeType: "image/jpeg", filename: timestampName("simulator", "jpg"), width: W, height: H }],
      exif: { camera: "AVOT Simulator", simulated: true },
    };
  }

  private paint(c: HTMLCanvasElement, w: number, h: number, ctx: CaptureContext | null) {
    const g = c.getContext("2d");
    if (!g) return;
    const s = w / 1200;
    g.fillStyle = "#2b2e2c";
    g.fillRect(0, 0, w, h);
    // page
    const px = 240 * s;
    const py = 90 * s;
    const pw = 720 * s;
    const ph = 720 * s;
    g.fillStyle = "#efe6d2";
    g.fillRect(px, py, pw, ph);
    g.strokeStyle = "#8a7550";
    g.lineWidth = 3 * s;
    g.strokeRect(px + 30 * s, py + 30 * s, pw - 60 * s, ph - 60 * s);
    g.fillStyle = "#3a2f22";
    g.textAlign = "center";
    g.direction = "rtl";
    g.font = `${54 * s}px serif`;
    g.fillText("ספר בדיקה", px + pw / 2, py + 150 * s);
    g.font = `${26 * s}px serif`;
    for (let i = 0; i < 12; i++) {
      g.fillRect(px + 90 * s, py + (230 + i * 34) * s, (pw - 180 * s) * (i % 3 === 2 ? 0.7 : 1), 6 * s);
    }
    // moving focus target so the live view visibly updates
    const t = this.frame / 30;
    g.strokeStyle = "#385a4c";
    g.lineWidth = 2 * s;
    g.beginPath();
    g.arc(px + pw / 2 + Math.sin(t) * 120 * s, py + ph - 110 * s, 40 * s, 0, Math.PI * 2);
    g.stroke();
    // watermark
    g.save();
    g.translate(w / 2, h / 2);
    g.rotate(-0.35);
    g.fillStyle = "rgba(155,59,46,0.30)";
    g.font = `bold ${120 * s}px sans-serif`;
    g.fillText("SIMULATOR", 0, 0);
    g.restore();
    g.fillStyle = "#e7e4dd";
    g.font = `${18 * s}px monospace`;
    g.textAlign = "start";
    g.direction = "ltr";
    const stamp = new Date().toISOString();
    g.fillText(ctx ? `AVOT SIMULATOR · catalog ${ctx.catalogNumber} · lot ${ctx.lotNumber} · ${ctx.category} · ${stamp}` : `AVOT SIMULATOR · live · ${stamp}`, 20 * s, h - 24 * s);
  }
}
