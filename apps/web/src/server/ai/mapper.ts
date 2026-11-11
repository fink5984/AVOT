import type { ItemType } from "@avot/shared";
import { AI_FIELD_NAMES, type AiFieldName, type AnalysisResult } from "./schema";
import { cleanAiText, headlineIssue, sameText } from "./text";

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
 * The item's name (title) is never replaced either: the AI's reading is a proposal the reviewer applies or ignores.
 * Extent and sizes are never written (a person counts and measures).
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
  /** re-analysis: fill every field anew (values a person entered, and the catalog draft, are replaced; the old values are in the run's snapshot) */
  overwrite?: boolean;
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

/* a collation token: 239 | [1] | רלו | ב-כב | 19.5-20.5 */
const LEAF = String.raw`(?:\[\d+\]|\d+(?:-\d+)?|[א-ת]{1,4}(?:-[א-ת]{1,4})?)`;
const COLLATION = new RegExp(String.raw`(?<=^|[\n.:]\s?|^\s)[ \t]*${LEAF}(?:,\s*${LEAF})*\s+(?:דף|דפים|עמ'|עמודים)(?:\s*\([^)\n]*\))?\s*(?:[.,;]|$)`, "gm");
const DANGLING_LABEL = /(?<=^|[\n.]\s?)[^.\n:"\s][^.\n:"]{0,49}:\s*(?=[^.\n:"]{1,50}:|מצב|$)/gm;
const SIZE = /[ \t]*(?:כ-)?\d+(?:[.,]\d+)?(?:\s*-\s*\d+(?:[.,]\d+)?)?(?:\s*[Xx×]\s*\d+(?:[.,]\d+)?)*\s*ס"מ(?:\s+בקירוב)?\s*[.,;]?/g;

/**
 * Extent and sizes are filled in by a person who counts and measures the item: the model's "239, [1] עמ'.",
 * "[2], רלו דף." or "22 ס"מ בקירוב." are guesses from photos (a page count from the last photographed page) and are
 * removed. Only whole collation statements go; "בדף השער", "בכל דף נדפס" stay.
 */
export function stripMeasurements(text: string | null): string | null {
  if (!text) return text;
  let out = text.replace(SIZE, "").replace(COLLATION, "");
  // labels left without their value ("סידור: תהלים: מצב טוב", "גובה התצלום: מצב טוב")
  for (let before = ""; before !== out; ) {
    before = out;
    out = out.replace(DANGLING_LABEL, "");
  }
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A catalog description comes in paragraphs (as in the examples). Models sometimes return one block, or the
 * two characters "\n" instead of a line break: those become real breaks, and a long single block at least gets the
 * condition ("מצב ...") as its own last paragraph.
 */
export function ensureParagraphs(text: string | null): string | null {
  if (!text) return text;
  let s = text.replace(/\\n/g, "\n");
  if (!s.includes("\n") && s.length > 350) s = s.replace(/(?<=[.!?"״])\s+(?=מצב\s)/, "\n\n");
  return s;
}

const NOT_READ: Partial<Record<string, string>> = { general_knowledge: "לפי ידע כללי", inference: "בהסקה" };
/** "חלק שני על פרשה צו", "ובו צדי"ק שערים": a real subtitle is a short line; more is the rest of the title page */
const SUBTITLE_MAX_WORDS = 15;

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
    if (inp.overwrite || (!opts.neverReplaceManual && grounded && !lowConfidence)) {
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
    // extent (pages) is never filled by the AI: a person counts it
    if (f === "extent") {
      decisions[f] = { action: "kept", reason: "ההיקף נקבע בידי אדם", proposed: null };
      continue;
    }
    const value = stripMeasurements(r.status === "found" ? r.value : null);
    // the item's name is the person's: the AI only proposes one, the reviewer applies it (and can undo) in the panel
    if (f === "title" && value && !isEmpty(current.title)) {
      const proposed = cleanAiText(value, AI_MAX_LENGTH.title);
      if (sameText(proposed, current.title)) decisions[f] = { action: "unchanged" };
      else if (editedDuringRun(f)) decisions[f] = { action: "skipped_human_edit", proposed };
      else {
        decisions[f] = { action: "kept", reason: "שם הפריט אינו מוחלף אוטומטית", proposed };
        review.push({ field: f, reason: `${FIELD_LABEL.title}: ה-AI מציע "${proposed!.slice(0, 120)}" - אפשר להחיל את ההצעה בלחיצה` });
      }
      continue;
    }
    // a "subtitle" of a whole title page (poems, acrostics, earlier editions...) is not a subtitle: it stays a
    // proposal the reviewer can apply, and the field is left alone
    if (f === "subtitle" && value && value.trim().split(/\s+/).length > SUBTITLE_MAX_WORDS) {
      decisions[f] = { action: "kept", reason: "ההצעה ארוכה מכדי להיות כותרת משנה", proposed: cleanAiText(value, AI_MAX_LENGTH.subtitle) };
      review.push({ field: f, reason: `${FIELD_LABEL.subtitle}: ה-AI הציע את נוסח השער כולו ולא שורת כותרת משנה; השדה לא מולא` });
      continue;
    }
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
  else if (inp.overwrite || current.itemType === "UNKNOWN" || fromPreviousAi("itemType") || t.confidence === "high") {
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
  decideText("catalogDescription", ensureParagraphs(stripMeasurements(stripImageIds(result.catalog.description))), true, lowCatalog, { neverReplaceManual: inp.catalogIsManual });

  for (const r of result.requiresReview) review.push({ field: r.field, reason: cleanAiText(r.reason, 500) ?? r.reason });
  review.push(...extraReviewNotes(result));
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

/** Notes for the reviewer that come from the main feature and the manuscript analysis (never from the model's own "requiresReview"). */
export function extraReviewNotes(result: AnalysisResult): { field: string; reason: string }[] {
  const notes: { field: string; reason: string }[] = [];
  const h = result.catalogHighlight;
  if (h && h.status === "found" && h.mainFeature && (!h.verified || h.confidence === "low")) {
    notes.push({ field: "catalogHighlight", reason: `המאפיין המרכזי ("${h.mainFeature}") אינו מאומת${h.evidence ? ` - ${h.evidence}` : ""}. יש לאמת אותו מול התמונות לפני פרסום.` });
  }
  const longHeadline = headlineIssue(result.catalog.headline);
  if (longHeadline) notes.push({ field: "catalogHeadline", reason: longHeadline });
  const m = result.manuscriptAnalysis;
  if (m?.isManuscript) {
    const text = `${result.catalog.headline ?? ""} ${result.catalog.description ?? ""}`;
    if (m.attributionLevel !== "autograph_certain" && /בעצם כתב ידו|כתב ידו המקורי|אוטוגרף/.test(text)) {
      notes.push({ field: "manuscriptAnalysis", reason: "הטקסט מציג את כתב היד כאוטוגרף, אך רמת הייחוס שנקבעה נמוכה יותר. יש לאמת את הייחוס." });
    }
    if (m.unreadable.length) notes.push({ field: "manuscriptAnalysis", reason: `חלקים בכתב היד שלא נקראו היטב: ${m.unreadable.join("; ")}` });
  }
  return notes;
}

/** Review notes for a result that is applied later (from a saved comparison), for the fields that were written. */
export function reviewForApplied(result: AnalysisResult, written: AiWritable[]): { field: string; reason: string }[] {
  const review: { field: string; reason: string }[] = [];
  for (const f of AI_FIELD_NAMES) {
    if (!written.includes(f)) continue;
    const r = result.fields[f];
    if (r.status !== "found") continue;
    if (r.confidence === "low") review.push({ field: f, reason: `${FIELD_LABEL[f]}: רמת ביטחון נמוכה${r.note ? ` - ${r.note}` : ""}` });
    const how = r.source ? NOT_READ[r.source] : undefined;
    if (how) review.push({ field: f, reason: `${FIELD_LABEL[f]}: נקבע ${how} ולא נקרא בתמונות - יש לאמת` });
  }
  for (const r of result.requiresReview) review.push({ field: r.field, reason: cleanAiText(r.reason, 500) ?? r.reason });
  for (const c of result.identification.conflicts) review.push({ field: "identification", reason: cleanAiText(c, 500) ?? c });
  review.push(...extraReviewNotes(result));
  const seen = new Set<string>();
  return review.filter((r) => {
    const k = r.reason.replace(/\s+/g, " ").trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
