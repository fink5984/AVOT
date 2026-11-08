import type { ItemType } from "@avot/shared";
import { AI_FIELD_NAMES, type AiFieldName, type AnalysisResult } from "./schema";
import { cleanAiText, sameText } from "./text";

/*
 * AI result → item fields. Pure (no database): every rule is unit tested.
 *
 * Only these fields can ever be written by the AI. Everything else on the item (id, inventory number, barcode,
 * consignor, location and its history, photos and files, photographer notes, internal notes, dimensions, sale and
 * settlement data, statuses) is out of reach by construction: the patch can only contain AI_WRITABLE keys.
 *
 * Per field:
 *  1. changed by a person while the analysis ran (current ≠ value at start)  → never touched, flagged for review;
 *  2. no value proposed (unknown / not checked / not applicable / empty)      → the existing value stays (never nulled);
 *  3. empty today                                                             → written;
 *  4. today's value is the previous AI result (not edited by a person since)  → replaced (re-analysis);
 *  5. today's value was entered by a person                                   → replaced only with new grounded evidence
 *     (read in the photos, confidence high / medium); otherwise kept and flagged. A replaced manual value is in the
 *     run's snapshot and can be restored.
 * The catalog draft (headline, description) written by a person is never replaced.
 */

export const AI_WRITABLE = [...AI_FIELD_NAMES, "itemType", "catalogHeadline", "catalogDescription"] as const;
export type AiWritable = (typeof AI_WRITABLE)[number];

export type AiValues = { [K in AiWritable]: K extends "itemType" ? ItemType : string | null };

export const AI_MAX_LENGTH: Record<Exclude<AiWritable, "itemType">, number> = {
  title: 300,
  subtitle: 300,
  author: 200,
  printPlace: 200,
  printYear: 50,
  publisher: 200,
  edition: 200,
  extent: 200,
  bibliographicNotes: 5000,
  conditionNotes: 2000,
  catalogHeadline: 500,
  catalogDescription: 20000,
};

export const FIELD_LABEL: Record<AiWritable, string> = {
  title: "שם הפריט",
  subtitle: "כותרת משנה",
  author: "מחבר / יוצר",
  printPlace: "מקום דפוס",
  printYear: "שנת דפוס",
  publisher: "מדפיס / הוצאה",
  edition: "מהדורה",
  extent: "היקף / דפים",
  bibliographicNotes: "פרטים ביבליוגרפיים",
  conditionNotes: "מצב העותק",
  itemType: "סוג הפריט",
  catalogHeadline: "כותרת קטלוגית",
  catalogDescription: "תיאור קטלוגי",
};

export type Decision =
  | { action: "written"; value: string; previous: string | null; replacedManual: boolean }
  | { action: "unchanged" }
  | { action: "kept"; reason: string; proposed: string | null }
  | { action: "skipped_human_edit"; proposed: string | null };

export interface MapOutcome {
  patch: Partial<AiValues>;
  decisions: Partial<Record<AiWritable, Decision>>;
  review: { field: string; reason: string }[];
  warnings: string[];
}

export interface MapInput {
  result: AnalysisResult;
  /** item values now (inside the write transaction) */
  current: AiValues;
  /** item values when the run started */
  base: AiValues;
  /** values the previous successful AI run wrote (null on a first analysis) */
  previousAi: Partial<AiValues> | null;
  /** ids of the images that were actually sent */
  imageIds: Set<string>;
  /** the catalog draft on the item was written by a person */
  catalogIsManual: boolean;
}

const isEmpty = (v: string | null | undefined) => !v || !v.trim();

/** image ids belong in the review notes, never in the catalog text a buyer reads ("(img-10)", "ב-img-02-top") */
export function stripImageIds(text: string | null): string | null {
  if (!text) return text;
  return text
    .replace(/[ \t]*\((?:ב-)?img-\d+(?:-(?:top|bottom))?(?:\s*,\s*img-\d+(?:-(?:top|bottom))?)*\)/g, "")
    .replace(/[ \t]*(?:ב-)?img-\d+(?:-(?:top|bottom))?(?:\s*,\s*img-\d+(?:-(?:top|bottom))?)*/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

const NOT_READ: Partial<Record<string, string>> = { general_knowledge: "לפי ידע כללי", inference: "בהסקה" };

export function mapResult(inp: MapInput): MapOutcome {
  const { result, current, base, previousAi } = inp;
  const patch: Partial<AiValues> = {};
  const decisions: MapOutcome["decisions"] = {};
  const review: MapOutcome["review"] = [];
  const warnings: string[] = [];

  const editedDuringRun = (f: AiWritable) => (f === "itemType" ? current.itemType !== base.itemType : !sameText(current[f] as string | null, base[f] as string | null));
  const fromPreviousAi = (f: AiWritable) => !!previousAi && previousAi[f] !== undefined && previousAi[f] !== null && (f === "itemType" ? previousAi.itemType === current.itemType : sameText(previousAi[f] as string | null, current[f] as string | null));

  function decideText(f: Exclude<AiWritable, "itemType">, proposedRaw: string | null, grounded: boolean, lowConfidence: boolean, opts: { neverReplaceManual?: boolean } = {}) {
    const proposed = cleanAiText(proposedRaw, AI_MAX_LENGTH[f]);
    if (editedDuringRun(f)) {
      decisions[f] = { action: "skipped_human_edit", proposed };
      if (proposed && !sameText(proposed, current[f])) review.push({ field: f, reason: `${FIELD_LABEL[f]} נערך ידנית בזמן הניתוח; הצעת ה-AI לא נכתבה ונשמרה בתוצאת הניתוח` });
      return;
    }
    if (!proposed) {
      decisions[f] = { action: "kept", reason: "לא הוצע ערך", proposed: null };
      return;
    }
    const now = current[f] as string | null;
    if (sameText(proposed, now)) {
      decisions[f] = { action: "unchanged" };
      return;
    }
    if (isEmpty(now) || fromPreviousAi(f)) {
      patch[f] = proposed;
      decisions[f] = { action: "written", value: proposed, previous: now, replacedManual: false };
      return;
    }
    if (!opts.neverReplaceManual && grounded && !lowConfidence) {
      patch[f] = proposed;
      decisions[f] = { action: "written", value: proposed, previous: now, replacedManual: true };
      review.push({ field: f, reason: `${FIELD_LABEL[f]}: הערך הידני הקודם ("${now!.slice(0, 80)}") הוחלף לפי הנראה בתמונות; ניתן לשחזר` });
      return;
    }
    decisions[f] = { action: "kept", reason: opts.neverReplaceManual ? "קיים ערך שנכתב ידנית" : "ערך ידני קיים; ההצעה אינה מבוססת דיה להחלפתו", proposed };
    review.push({ field: f, reason: `${FIELD_LABEL[f]}: ה-AI הציע ערך אחר ("${proposed.slice(0, 80)}"); הערך הקיים נשמר` });
  }

  for (const f of AI_FIELD_NAMES) {
    const r = result.fields[f];
    const value = r.status === "found" ? r.value : null;
    decideText(f, value, r.source === "image", r.confidence === "low" || r.confidence === null);
    if (r.status === "found" && r.confidence === "low" && decisions[f]?.action === "written") review.push({ field: f, reason: `${FIELD_LABEL[f]}: רמת ביטחון נמוכה${r.note ? ` - ${r.note}` : ""}` });
    // a value the model did not read in the photos (identified from knowledge or inferred) always needs a person,
    // whatever confidence the model claims
    const how = r.status === "found" && r.source ? NOT_READ[r.source] : undefined;
    if (how && decisions[f]?.action === "written") review.push({ field: f, reason: `${FIELD_LABEL[f]}: נקבע ${how} ולא נקרא בתמונות - יש לאמת` });
    for (const id of r.imageIds) if (!inp.imageIds.has(id)) warnings.push(`המודל ציין מזהה תמונה שלא נשלח (${id}) בשדה ${f}`);
  }

  // item type: decided by evidence, a person's choice wins unless the evidence is strong
  const t = result.itemType;
  if (editedDuringRun("itemType")) decisions.itemType = { action: "skipped_human_edit", proposed: t.value };
  else if (t.value === "UNKNOWN" || t.value === current.itemType) decisions.itemType = { action: "unchanged" };
  else if (current.itemType === "UNKNOWN" || fromPreviousAi("itemType") || t.confidence === "high") {
    patch.itemType = t.value;
    decisions.itemType = { action: "written", value: t.value, previous: current.itemType, replacedManual: current.itemType !== "UNKNOWN" && !fromPreviousAi("itemType") };
    if (t.confidence === "low") review.push({ field: "itemType", reason: `סוג הפריט נקבע ברמת ביטחון נמוכה${t.note ? ` - ${t.note}` : ""}` });
  } else {
    decisions.itemType = { action: "kept", reason: "סוג פריט שנבחר ידנית", proposed: t.value };
    review.push({ field: "itemType", reason: `ה-AI זיהה סוג פריט אחר (${t.value}); הסוג שנבחר ידנית נשמר` });
  }

  // catalog draft: AI may replace its own earlier draft, never a person's
  const lowCatalog = result.catalog.confidence === "low";
  decideText("catalogHeadline", stripImageIds(result.catalog.headline), true, lowCatalog, { neverReplaceManual: inp.catalogIsManual });
  decideText("catalogDescription", stripImageIds(result.catalog.description), true, lowCatalog, { neverReplaceManual: inp.catalogIsManual });

  for (const r of result.requiresReview) review.push({ field: r.field, reason: cleanAiText(r.reason, 500) ?? r.reason });
  for (const c of result.identification.conflicts) review.push({ field: "identification", reason: cleanAiText(c, 500) ?? c });
  for (const fd of result.findings) for (const id of fd.imageIds) if (!inp.imageIds.has(id)) warnings.push(`המודל ציין מזהה תמונה שלא נשלח (${id}) בממצא ${fd.kind}`);

  // the model often repeats the same remark for several fields: one line per distinct reason is enough
  const seen = new Set<string>();
  const uniqueReview = review.filter((r) => {
    const k = r.reason.replace(/\s+/g, " ").trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { patch, decisions, review: uniqueReview, warnings: [...new Set(warnings)] };
}
