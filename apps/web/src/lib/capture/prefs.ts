"use client";

import type { CameraKind } from "./drivers/types";

/** Per-user capture preferences. Shortcuts are stored as KeyboardEvent.code, so they work in any keyboard layout (Hebrew/English). */
export interface CapturePrefs {
  sound: boolean;
  /** extra capture key besides Space, e.g. a USB foot pedal ("PageDown", "F13", "KeyB") */
  captureKey: string | null;
  categoryKeys: [string, string, string, string];
  nextLotKey: string;
  prevLotKey: string;
  grid: "none" | "thirds" | "fine";
  centerLines: boolean;
  continuous: boolean;
  completeStatus: "COMPLETED" | "PENDING_REVIEW";
  agentUrl: string;
  lastCamera: { kind: CameraKind; id: string; label?: string } | null;
  filmstripScope: "category" | "all";
}

export const DEFAULT_PREFS: CapturePrefs = {
  sound: true,
  captureKey: null,
  categoryKeys: ["Digit1", "Digit2", "Digit3", "Digit4"],
  nextLotKey: "KeyN",
  prevLotKey: "KeyP",
  grid: "thirds",
  centerLines: false,
  continuous: false,
  completeStatus: "COMPLETED",
  agentUrl: "http://127.0.0.1:47800",
  lastCamera: null,
  filmstripScope: "category",
};

const LS_KEY = "avot.capturePrefs";

export function mergePrefs(server: unknown): CapturePrefs {
  let local: Partial<CapturePrefs> = {};
  try {
    local = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}");
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_PREFS, ...local, ...((server as Partial<CapturePrefs> | null) ?? {}) };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function savePrefs(prefs: CapturePrefs): Promise<void> {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage may be unavailable */
  }
  if (saveTimer) clearTimeout(saveTimer);
  return new Promise((resolve, reject) => {
    saveTimer = setTimeout(async () => {
      try {
        const res = await fetch("/api/preferences/capture", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ value: prefs }),
        });
        if (!res.ok) throw new Error("save failed");
        resolve();
      } catch (e) {
        reject(e);
      }
    }, 500);
  });
}

/** Human-readable name for a KeyboardEvent.code. */
export function keyLabel(code: string | null): string {
  if (!code) return "—";
  if (code === "Space") return "רווח";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  const map: Record<string, string> = {
    Enter: "Enter",
    PageDown: "Page Down",
    PageUp: "Page Up",
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    BracketLeft: "[",
    BracketRight: "]",
    Backquote: "`",
  };
  return map[code] ?? code;
}

/** Plays a short, quiet shutter tick with Web Audio (no audio file needed). */
let audioCtx: AudioContext | null = null;
export function playShutter() {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(1800, t);
    osc.frequency.exponentialRampToValueAtTime(600, t + 0.06);
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.09);
  } catch {
    /* audio is optional */
  }
}

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "color", "file", "image"]);

/**
 * True when the user is entering text — shortcuts must not fire then. Focus on a
 * checkbox, slider or button (e.g. after clicking a panel control) is NOT typing:
 * Space must still capture instead of toggling that control.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type);
  return !!el.closest("textarea, select, [contenteditable=''], [contenteditable='true']");
}
