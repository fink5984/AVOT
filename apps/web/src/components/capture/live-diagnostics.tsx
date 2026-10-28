"use client";

import { sharpnessVerdict } from "@/lib/capture/sharpness";
import type { LiveMetrics } from "./live-view";

const SOURCE: Record<string, string> = {
  CANON: "Canon EDSDK — זרם EVF של המצלמה דרך Capture Desktop",
  DIGICAM: "digiCamControl — זרם תצוגה חיה",
  AGENT_SIMULATOR: "סימולטור (לא מצלמה אמיתית)",
  WEBCAM: "מצלמת רשת (WebRTC)",
  SIMULATOR: "סימולטור בדפדפן",
};

/**
 * Where the live picture can lose sharpness: the camera's own EVF size (fixed by the camera and the SDK), the
 * browser's scaling, a software zoom, and — never the processing, which is drawn as a separate layer.
 */
export function LiveDiagnostics({
  metrics,
  driverKind,
  evfZoom,
  processing,
  onClose,
}: {
  metrics: LiveMetrics | null;
  driverKind: string | undefined;
  evfZoom: string | undefined;
  processing: string | undefined;
  onClose: () => void;
}) {
  const verdict = metrics ? sharpnessVerdict(metrics) : null;
  const rows: [string, string][] = [
    ["מקור התמונה", driverKind ? (SOURCE[driverKind] ?? driverKind) : "—"],
    ["רזולוציית המקור", metrics ? `${metrics.srcW}×${metrics.srcH} פיקסלים` : "—"],
    ["גודל התצוגה", metrics ? `${metrics.shownW}×${metrics.shownH} px (CSS) · ×${metrics.dpr} צפיפות מסך` : "—"],
    ["יחס קנה מידה", metrics ? `${metrics.scale.toFixed(2)}× (פיקסל מסך לפיקסל מקור)` : "—"],
    ["הגדלה בתוכנה", metrics ? (metrics.swZoom === 1 ? "ללא" : `${metrics.swZoom}× — הגדלת תצוגה בלבד`) : "—"],
    ["הגדלה במצלמה (EVF)", evfZoom ? (evfZoom === "1" ? "מלאה (ללא הגדלה)" : `${evfZoom}× — פרטים אמיתיים מהחיישן`) : "לא זמינה"],
    ["שכבת העיבוד", processing ? `${processing} — שכבה נפרדת מעל הזרם, לא משנה את חדות התמונה` : "—"],
  ];
  return (
    <div className="w-[320px] max-w-[calc(100vw-24px)] rounded-xl bg-black/75 p-3 text-[12.5px] text-studio-text ring-1 ring-white/10 backdrop-blur-md" role="region" aria-label="אבחון חדות התצוגה החיה" data-testid="live-diagnostics">
      <div className="mb-2 flex items-center justify-between">
        <strong className="text-[13px]">אבחון חדות</strong>
        <button type="button" onClick={onClose} className="rounded px-1.5 text-studio-muted hover:text-studio-text" aria-label="סגירה">
          ✕
        </button>
      </div>
      <dl className="space-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="shrink-0 text-studio-muted">{k}</dt>
            <dd className="text-end">{v}</dd>
          </div>
        ))}
      </dl>
      {verdict && (
        <p className={verdict.tone === "warn" ? "mt-2 rounded-md bg-[#4a3a1a] px-2 py-1.5 text-[#f2d79e]" : "mt-2 rounded-md bg-white/10 px-2 py-1.5"} data-testid="sharpness-verdict">
          {verdict.text}
        </p>
      )}
    </div>
  );
}
