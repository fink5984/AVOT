"use client";

/**
 * Scan sources for the warehouse handheld.
 *
 * 1. Keyboard wedge (default): the device's built-in scanner "types" the code
 *    into the focused input and sends Enter. Works with Newland MT93 / Zebra /
 *    Honeywell in keyboard-emulation mode, and with USB scanners on a PC.
 * 2. Device API adapter: a native wrapper (e.g. an Android WebView that
 *    receives the scanner's broadcast Intent) can deliver scans without
 *    keyboard emulation by calling `window.avotScanner.push(code)` or
 *    dispatching `new CustomEvent("avot-scan", { detail: { code } })`.
 *    No native app is part of this release — the hook is the contract for one.
 */

export type ScanHandler = (code: string, source: "wedge" | "adapter" | "manual") => void;

declare global {
  interface Window {
    avotScanner?: { push: (code: string) => void; version: number };
  }
}

/** Registers the device-API adapter entry points. Returns an unsubscribe. */
export function attachAdapter(onScan: ScanHandler): () => void {
  const onEvent = (e: Event) => {
    const code = (e as CustomEvent<{ code?: string }>).detail?.code;
    if (typeof code === "string" && code.trim()) onScan(code, "adapter");
  };
  window.addEventListener("avot-scan", onEvent);
  window.avotScanner = { push: (code) => code?.trim() && onScan(code, "adapter"), version: 1 };
  return () => {
    window.removeEventListener("avot-scan", onEvent);
    delete window.avotScanner;
  };
}

/**
 * Suppresses the same code arriving again within `windowMs` — a trigger held
 * a little too long, or a wedge + adapter both delivering. Different codes are
 * never suppressed. (The server is the real guard: re-sent opIds are replayed
 * and a second scan of a book already on that shelf is a no-op.)
 */
export function createDebouncer(windowMs = 700) {
  let last = "";
  let at = 0;
  return (code: string) => {
    const now = Date.now();
    const dup = code === last && now - at < windowMs;
    last = code;
    at = now;
    return dup;
  };
}

let ctx: AudioContext | null = null;
function tone(freq: number, ms: number, startOffset = 0, type: OscillatorType = "square", gainValue = 0.08) {
  ctx ??= new AudioContext();
  const t = ctx.currentTime + startOffset;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(gainValue, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + ms / 1000 + 0.02);
}

/** Distinct sounds: success (one high beep), warning / queued (two mid), error (low buzz + vibration). */
export function feedback(kind: "ok" | "warn" | "error" | "queued") {
  try {
    if (kind === "ok") tone(1760, 90, 0, "sine", 0.12);
    else if (kind === "queued") {
      tone(1320, 70, 0, "sine", 0.1);
      tone(1320, 70, 0.11, "sine", 0.1);
    } else if (kind === "warn") {
      tone(880, 110, 0, "triangle", 0.12);
      tone(1100, 110, 0.14, "triangle", 0.12);
    } else {
      tone(220, 380, 0, "square", 0.1);
    }
  } catch {
    /* audio may be blocked until the first touch — the visual result is always shown */
  }
  if (kind === "error") navigator.vibrate?.([120, 60, 220]);
  else if (kind === "warn") navigator.vibrate?.(80);
}
