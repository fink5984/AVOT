import type { DeskewDecision, DeskewSkip } from "./deskew";

/**
 * Report side of the straightening batch tool: how a decision is named in the report, what the dry-run totals
 * are, and which ~30 photos the preview shows. Pure functions — no database, no storage.
 */

/** one examined photo */
export type DeskewVerdict =
  /** a confident, small tilt: the batch would rotate it */
  | "can-straighten"
  | "already-straight"
  /** several items / mixed directions: left as shot on purpose */
  | "composition"
  | "low-confidence"
  /** a large tilt: probably deliberate, needs a human */
  | "angle-too-large"
  | "manual-edits"
  | "already-checked"
  | "not-processed"
  | "error";

export function verdictOf(d: DeskewDecision): DeskewVerdict {
  if (d.apply) return "can-straighten";
  switch (d.skip) {
    case "already-straight":
      return "already-straight";
    case "multiple-objects":
    case "mixed-directions":
      return "composition";
    case "angle-too-large":
      return "angle-too-large";
    case "manual-edits":
      return "manual-edits";
    default:
      return "low-confidence";
  }
}

export const VERDICT_LABEL: Record<DeskewVerdict, string> = {
  "can-straighten": "ניתן ליישר",
  "already-straight": "כבר ישר",
  composition: "קומפוזיציה / כמה פריטים — לא נוגעים",
  "low-confidence": "ביטחון נמוך — לא נוגעים",
  "angle-too-large": "הטיה גדולה (נראית מכוונת) — נדרשת בדיקה",
  "manual-edits": "יש תיקון ידני — לא נוגעים",
  "already-checked": "כבר נבדק בגרסה הזו",
  "not-processed": "לא עבר עיבוד תמונה",
  error: "שגיאה",
};

export const SKIP_LABEL: Record<DeskewSkip, string> = {
  disabled: "היישור כבוי בהגדרות",
  "manual-edits": "יש חיתוך או מחיקה ידנית",
  "detection-untrusted": "זיהוי הספר לא ודאי",
  "no-object": "לא נמצא פריט",
  "multiple-objects": "כמה פריטים בתמונה",
  "mixed-directions": "כמה כיוונים שונים בתמונה",
  "touches-frame": "הפריט נחתך על ידי המסגרת",
  "low-confidence": "ביטחון נמוך בזווית",
  "estimates-disagree": "שתי שיטות המדידה לא מסכימות",
  "already-straight": "הפריט כבר ישר",
  "angle-too-large": "הטיה גדולה — נראית מכוונת",
  "not-verified": "הסיבוב לא שיפר את הישרות — בוטל",
};

export interface ReportRow {
  assetId: string;
  inventoryNumber: string | null;
  itemType: string | null;
  category: string | null;
  verdict: DeskewVerdict;
  /** suggested rotation, degrees clockwise (0 when none) */
  angle: number;
  tilt: number;
  confidence: number;
  kind: string | null;
  skip: string | null;
  error?: string;
  ms?: number;
}

export interface ReportTotals {
  examined: number;
  byVerdict: Record<DeskewVerdict, number>;
}

export function totalsOf(rows: ReportRow[]): ReportTotals {
  const byVerdict = Object.fromEntries((Object.keys(VERDICT_LABEL) as DeskewVerdict[]).map((k) => [k, 0])) as Record<DeskewVerdict, number>;
  for (const r of rows) byVerdict[r.verdict]++;
  return { examined: rows.length, byVerdict };
}

/**
 * ~n photos for the human check: every kind of decision is represented, and within it the different kinds of item
 * (single book, open book, several books, covers, posters …) — by item type first, then evenly over the angles.
 * Deterministic for the same rows.
 */
export function pickPreviewSample(rows: ReportRow[], n = 30): ReportRow[] {
  const quota: [DeskewVerdict[], number][] = [
    [["can-straighten"], Math.round(n * 0.4)],
    [["already-straight"], Math.round(n * 0.13)],
    [["composition"], Math.round(n * 0.2)],
    [["low-confidence"], Math.round(n * 0.13)],
    [["angle-too-large"], Math.round(n * 0.07)],
  ];
  const chosen: ReportRow[] = [];
  const taken = new Set<string>();
  const take = (pool: ReportRow[], count: number) => {
    // spread over item types, then over the angle range
    const byType = new Map<string, ReportRow[]>();
    for (const r of pool.filter((x) => !taken.has(x.assetId)).sort((a, b) => a.tilt - b.tilt || a.assetId.localeCompare(b.assetId))) {
      const k = `${r.itemType ?? "?"}/${r.category ?? "?"}`;
      byType.set(k, [...(byType.get(k) ?? []), r]);
    }
    const lanes = [...byType.values()];
    let added = 0;
    for (let round = 0; added < count && lanes.some((l) => l.length > 0); round++) {
      for (const lane of lanes) {
        if (added >= count) break;
        if (!lane.length) continue;
        // alternate between the two ends of the angle range so small and large tilts both show up
        const r = round % 2 === 0 ? lane.shift()! : lane.pop()!;
        chosen.push(r);
        taken.add(r.assetId);
        added++;
      }
    }
    return added;
  };
  let missing = 0;
  for (const [verdicts, count] of quota) missing += count - take(rows.filter((r) => verdicts.includes(r.verdict)), count + missing);
  if (chosen.length < n) take(rows.filter((r) => r.verdict !== "error"), n - chosen.length);
  return chosen.slice(0, n);
}

export function reportCsv(rows: ReportRow[]): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["assetId", "inventoryNumber", "itemType", "category", "verdict", "suggestedAngle", "measuredTilt", "confidence", "kind", "skipReason", "error"];
  const lines = rows.map((r) => [r.assetId, r.inventoryNumber, r.itemType, r.category, r.verdict, r.angle, r.tilt, r.confidence, r.kind, r.skip, r.error].map(esc).join(","));
  // BOM so Excel opens the Hebrew correctly
  return "﻿" + [head.map(esc).join(","), ...lines].join("\r\n") + "\r\n";
}

export function summaryText(t: ReportTotals, extra: { algo: number; startedAt: string; org: string }): string {
  const v = t.byVerdict;
  return [
    `דוח בדיקת יישור (Dry Run) — גרסת אלגוריתם ${extra.algo}`,
    `ארגון: ${extra.org} | הופק: ${extra.startedAt}`,
    `לא בוצע שום שינוי בנתונים או בקבצים.`,
    ``,
    `נבדקו:                         ${t.examined}`,
    `ניתן ליישר:                    ${v["can-straighten"]}`,
    `כבר מיושרות:                   ${v["already-straight"]}`,
    `קומפוזיציה (כמה פריטים):       ${v.composition}`,
    `ביטחון נמוך / לא ודאי:         ${v["low-confidence"]}`,
    `הטיה גדולה, נדרשת בדיקה:       ${v["angle-too-large"]}`,
    `עם תיקון ידני (לא נוגעים):     ${v["manual-edits"]}`,
    `כבר נבדקו בגרסה הזו:           ${v["already-checked"]}`,
    `לא עברו עיבוד תמונה:           ${v["not-processed"]}`,
    `שגיאות:                        ${v.error}`,
    ``,
  ].join("\n");
}
