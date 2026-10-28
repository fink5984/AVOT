/**
 * One barcode shown to the camera = one scan.
 *
 * The camera decodes ~10 frames a second, so a barcode that stays in view is "seen" over and over. A fixed pause
 * (the old cooldown) breaks as soon as recognition drops for a moment (focus hunting, glare, a hand shadow) and the
 * same code is reported again. This gate is presence-based instead:
 *  - a code is reported the first time it is seen and then LOCKED;
 *  - while it keeps being seen, nothing more is reported — for 30 seconds or 30 minutes;
 *  - it is released only when it has been absent from the frames for `clearMs` (the worker really took it away);
 *  - a different code is reported at once and does not wait for, or disturb, the lock of another code;
 *  - `rearm()` ("סרוק שוב") releases everything for a deliberate repeat while the barcode stays in view.
 * Frames are what count, not wall-clock pauses: a frame that decodes nothing does not release a lock until it has
 * lasted `clearMs`.
 */
export function createScanGate(clearMs = 1200, now: () => number = Date.now) {
  const lastSeen = new Map<string, number>();
  return {
    /** Feed the codes decoded in ONE frame (possibly none). Returns the codes to report now. */
    frame(codes: string[]): string[] {
      const t = now();
      for (const [code, seen] of lastSeen) if (t - seen >= clearMs) lastSeen.delete(code);
      const out: string[] = [];
      for (const raw of new Set(codes)) {
        const code = raw.trim();
        if (!code) continue;
        if (!lastSeen.has(code)) out.push(code);
        lastSeen.set(code, t);
      }
      return out;
    },
    /** A deliberate repeat: the next sighting of any code is a new scan. */
    rearm() {
      lastSeen.clear();
    },
  };
}
