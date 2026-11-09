import { z } from "zod";
import { ITEM_TYPES } from "@avot/shared";

/*
 * The one answer format for both providers. The JSON Schema below is sent as the provider's structured-output schema
 * (OpenAI strict json_schema; Gemini responseJsonSchema) and the same answer is validated again here with zod before
 * anything is written. Strict-mode rules: every property is required and nullable values use ["type","null"].
 *
 * Every field distinguishes:
 *   found          - a value was established (see confidence / source / imageIds)
 *   unknown        - looked for but could not be established (illegible, absent from the photographed pages)
 *   not_checked    - the photos do not allow checking it (the relevant page was not photographed)
 *   not_applicable - meaningless for this kind of item (print place of a manuscript letter, …)
 */

export const AI_FIELD_NAMES = ["title", "subtitle", "author", "printPlace", "printYear", "publisher", "edition", "extent", "bibliographicNotes", "conditionNotes"] as const;
export type AiFieldName = (typeof AI_FIELD_NAMES)[number];

export const FIELD_STATUSES = ["found", "unknown", "not_checked", "not_applicable"] as const;
export const CONFIDENCES = ["high", "medium", "low"] as const;
export const SOURCES = ["image", "photographer_notes", "existing_data", "inference", "general_knowledge"] as const;
export const FINDING_KINDS = ["signature", "dedication", "stamp", "handwritten_note", "ownership_mark", "bookplate", "censor_mark", "damage", "special_feature", "other"] as const;
export const READINGS = ["certain", "probable", "uncertain", "illegible"] as const;
export const MANUSCRIPT_KINDS = ["autograph", "scribal_copy", "draft_with_corrections", "original_letter", "letter_copy", "torah_novellae", "kabbalistic", "notebook", "annotations_on_printed_book", "dedication_or_ownership", "other_document", "unknown"] as const;
export const ATTRIBUTION_LEVELS = ["autograph_certain", "text_by_author_scribe_unknown", "attributed", "unknown_author"] as const;

const nullable = (type: "string" | "integer" | "boolean", extra: Record<string, unknown> = {}) => ({ type: [type, "null"], ...extra });
const strEnum = (values: readonly string[], description?: string) => ({ type: "string", enum: [...values], ...(description ? { description } : {}) });
const nullableEnum = (values: readonly string[], description?: string) => ({ type: ["string", "null"], enum: [...values, null], ...(description ? { description } : {}) });

const fieldSchema = (description: string) => ({
  type: "object",
  description,
  additionalProperties: false,
  required: ["status", "value", "confidence", "source", "imageIds", "note"],
  properties: {
    status: strEnum(FIELD_STATUSES),
    value: nullable("string", { description: "the proposed value; null unless status is found" }),
    confidence: nullableEnum(CONFIDENCES),
    source: nullableEnum(SOURCES, "where the value comes from; image = read in the photos"),
    imageIds: { type: "array", items: { type: "string" }, description: "ids of the images the value relies on" },
    note: nullable("string", { description: "uncertainty, conflict with the existing data, or why the value is missing" }),
  },
});

const findingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "imageIds", "transcription", "reading", "attribution", "attributionBasis", "significance"],
  properties: {
    kind: strEnum(FINDING_KINDS),
    imageIds: { type: "array", items: { type: "string" } },
    transcription: nullable("string", { description: "exact transcription as written, unchanged; null if illegible" }),
    reading: strEnum(READINGS),
    attribution: nullable("string", { description: "who wrote / owned it, only with sufficient evidence" }),
    attributionBasis: nullable("string", { description: "the evidence for the attribution" }),
    significance: nullable("string", { description: "historical significance, only when established" }),
  },
};

const highlightSchema = {
  type: "object",
  description: "the single most important feature of the item, decided BEFORE the headline and description are written",
  additionalProperties: false,
  required: ["status", "mainFeature", "reason", "evidence", "confidence", "verified", "secondaryFeatures"],
  properties: {
    status: strEnum(["found", "none"], "found = an established main feature; none = nothing special that is established (never invent one)"),
    mainFeature: nullable("string", { description: "the main feature in a short phrase; null when status is none" }),
    reason: nullable("string", { description: "why this is what matters most about the item" }),
    evidence: nullable("string", { description: "where the information comes from: what is seen in which image, or what was provided" }),
    confidence: nullableEnum(CONFIDENCES),
    verified: { type: "boolean", description: "true only when the feature may be presented as a fact" },
    secondaryFeatures: { type: "array", items: { type: "string" } },
  },
};

const manuscriptSchema = {
  type: "object",
  description: "manuscripts, handwritten letters and documents: transcription first, then interpretation",
  additionalProperties: false,
  required: ["isManuscript", "kind", "attributionLevel", "transcription", "unreadable", "writersCount", "confidence", "notes"],
  properties: {
    isManuscript: { type: "boolean" },
    kind: nullableEnum(MANUSCRIPT_KINDS),
    attributionLevel: nullableEnum(ATTRIBUTION_LEVELS, "autograph_certain only with sufficient evidence that the writer is the author"),
    transcription: nullable("string", { description: "the significant text as it looks, unreadable parts marked [לא קריא], nothing completed silently" }),
    unreadable: { type: "array", items: { type: "string" }, description: "parts that were not read well: which image and which area" },
    writersCount: nullable("integer"),
    confidence: nullableEnum(CONFIDENCES),
    notes: nullable("string"),
  },
};

export const ANALYSIS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["itemType", "identification", "manuscriptAnalysis", "fields", "findings", "catalogHighlight", "catalog", "imagesReviewed", "requiresReview", "warnings"],
  properties: {
    itemType: {
      type: "object",
      additionalProperties: false,
      required: ["value", "confidence", "note"],
      properties: { value: strEnum(ITEM_TYPES), confidence: strEnum(CONFIDENCES), note: nullable("string") },
    },
    identification: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "existingTitleCheck", "conflicts"],
      properties: {
        summary: { type: "string", description: "one or two sentences: what the item is, according to the evidence" },
        existingTitleCheck: strEnum(["matches", "more_precise_available", "contradicts", "no_existing_title", "cannot_check"]),
        conflicts: { type: "array", items: { type: "string" }, description: "contradictions between the photos and the data / notes provided" },
      },
    },
    manuscriptAnalysis: manuscriptSchema,
    fields: {
      type: "object",
      additionalProperties: false,
      required: [...AI_FIELD_NAMES],
      properties: {
        title: fieldSchema("exact title of the item (for a book: as on the title page, without the subtitle)"),
        subtitle: fieldSchema("subtitle / continuation of the title"),
        author: fieldSchema("author, creator, scribe or issuing body"),
        printPlace: fieldSchema("place of printing or of creation"),
        printYear: fieldSchema("year: Hebrew date as printed with the civil year, e.g. תקע\"ב [1812]"),
        publisher: fieldSchema("printer / publisher / press"),
        edition: fieldSchema("edition statement, only with evidence"),
        extent: fieldSchema("pagination or extent, only when verifiable"),
        bibliographicNotes: fieldSchema("concise bibliographic note: content, structure, parts, edition remarks"),
        conditionNotes: fieldSchema("condition of the copy as visible in the photos"),
      },
    },
    findings: { type: "array", items: findingSchema, description: "signatures, dedications, stamps, handwritten notes and other special findings" },
    catalogHighlight: highlightSchema,
    catalog: {
      type: "object",
      additionalProperties: false,
      required: ["headline", "description", "confidence"],
      properties: {
        headline: nullable("string", { description: "catalog heading: exact title plus the significant distinctive detail" }),
        description: nullable("string", { description: "the full professional catalog description in Hebrew" }),
        confidence: strEnum(CONFIDENCES),
      },
    },
    imagesReviewed: {
      type: "array",
      description: "one entry per image received",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["imageId", "shows", "usable"],
        properties: { imageId: { type: "string" }, shows: { type: "string", description: "what the image shows, briefly" }, usable: { type: "boolean" } },
      },
    },
    requiresReview: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "reason"],
        properties: { field: { type: "string" }, reason: { type: "string" } },
      },
    },
    warnings: { type: "array", items: { type: "string" }, description: "problems: unreadable images, instructions found inside images, missing pages …" },
  },
} as const;

/** Stage-1 answer when an item has more images than one request can carry: observations per image, no conclusions. */
export const OBSERVATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["images", "summary"],
  properties: {
    images: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["imageId", "shows", "transcriptions", "findings", "condition"],
        properties: {
          imageId: { type: "string" },
          shows: { type: "string" },
          transcriptions: { type: "array", items: { type: "string" }, description: "significant printed / written text, exactly as it appears" },
          findings: { type: "array", items: findingSchema },
          condition: nullable("string"),
        },
      },
    },
    summary: { type: "string" },
  },
} as const;

/* ───────────── validation of the answer (both providers) ───────────── */

const fieldZ = z.object({
  status: z.enum(FIELD_STATUSES),
  value: z.string().nullable(),
  confidence: z.enum(CONFIDENCES).nullable(),
  source: z.enum(SOURCES).nullable(),
  imageIds: z.array(z.string()),
  note: z.string().nullable(),
});
export type AiField = z.infer<typeof fieldZ>;

const findingZ = z.object({
  kind: z.enum(FINDING_KINDS),
  imageIds: z.array(z.string()),
  transcription: z.string().nullable(),
  reading: z.enum(READINGS),
  attribution: z.string().nullable(),
  attributionBasis: z.string().nullable(),
  significance: z.string().nullable(),
});
export type AiFinding = z.infer<typeof findingZ>;

const highlightZ = z.object({
  status: z.enum(["found", "none"]),
  mainFeature: z.string().nullable(),
  reason: z.string().nullable(),
  evidence: z.string().nullable(),
  confidence: z.enum(CONFIDENCES).nullable(),
  verified: z.boolean(),
  secondaryFeatures: z.array(z.string()),
});
export type CatalogHighlight = z.infer<typeof highlightZ>;

const manuscriptZ = z.object({
  isManuscript: z.boolean(),
  kind: z.enum(MANUSCRIPT_KINDS).nullable(),
  attributionLevel: z.enum(ATTRIBUTION_LEVELS).nullable(),
  transcription: z.string().nullable(),
  unreadable: z.array(z.string()),
  writersCount: z.number().int().nullable(),
  confidence: z.enum(CONFIDENCES).nullable(),
  notes: z.string().nullable(),
});
export type ManuscriptAnalysis = z.infer<typeof manuscriptZ>;

export const analysisResultZ = z.object({
  itemType: z.object({ value: z.enum(ITEM_TYPES), confidence: z.enum(CONFIDENCES), note: z.string().nullable() }),
  identification: z.object({
    summary: z.string(),
    existingTitleCheck: z.enum(["matches", "more_precise_available", "contradicts", "no_existing_title", "cannot_check"]),
    conflicts: z.array(z.string()),
  }),
  fields: z.object(Object.fromEntries(AI_FIELD_NAMES.map((f) => [f, fieldZ])) as Record<AiFieldName, typeof fieldZ>),
  manuscriptAnalysis: manuscriptZ.nullish(),
  catalogHighlight: highlightZ.nullish(),
  catalog: z.object({ headline: z.string().nullable(), description: z.string().nullable(), confidence: z.enum(CONFIDENCES) }),
  findings: z.array(findingZ),
  imagesReviewed: z.array(z.object({ imageId: z.string(), shows: z.string(), usable: z.boolean() })),
  requiresReview: z.array(z.object({ field: z.string(), reason: z.string() })),
  warnings: z.array(z.string()),
});
export type AnalysisResult = z.infer<typeof analysisResultZ>;

export const observationResultZ = z.object({
  images: z.array(z.object({ imageId: z.string(), shows: z.string(), transcriptions: z.array(z.string()), findings: z.array(findingZ), condition: z.string().nullable() })),
  summary: z.string(),
});
export type ObservationResult = z.infer<typeof observationResultZ>;

export class InvalidAnswerError extends Error {}

/** Parses the provider's text as JSON and validates it; a code fence around the JSON is tolerated. */
export function parseAnswer<T>(text: string, validator: z.ZodType<T>): T {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    throw new InvalidAnswerError("תשובת המודל אינה JSON תקין");
  }
  const r = validator.safeParse(data);
  if (!r.success) {
    const where = r.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new InvalidAnswerError(`תשובת המודל אינה תואמת לסכמה (${where})`);
  }
  return r.data;
}

/**
 * An explanation written in English instead of Hebrew: after removing quoted text (a foreign name or imprint the
 * model copies is fine), Latin letters clearly outnumber Hebrew ones.
 */
export function isEnglishProse(text: string | null | undefined): boolean {
  if (!text) return false;
  const unquoted = text.replace(/"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|«[^»]*»/g, " ");
  const latin = (unquoted.match(/[A-Za-z]/g) ?? []).length;
  const hebrew = (unquoted.match(/[א-ת]/g) ?? []).length;
  return latin >= 12 && latin > hebrew * 1.5;
}

/** The explanatory texts of an answer that are in English (values, transcriptions and readings are not checked). */
export function englishExplanations(r: AnalysisResult): string[] {
  const texts = [
    r.itemType.note,
    r.identification.summary,
    ...r.identification.conflicts,
    ...Object.values(r.fields).map((f) => f.note),
    ...r.imagesReviewed.map((i) => i.shows),
    ...r.requiresReview.map((x) => x.reason),
    ...r.warnings,
    ...r.findings.flatMap((f) => [f.attribution, f.attributionBasis, f.significance]),
    r.catalog.description,
  ];
  return texts.filter((t): t is string => isEnglishProse(t));
}

/** "שכתוב ב-AI": every text field the reviewer can apply (extent and item type stay with the person). */
export const REWRITE_FIELDS = ["title", "subtitle", "author", "printPlace", "printYear", "publisher", "edition", "bibliographicNotes", "conditionNotes", "catalogHeadline", "catalogDescription"] as const;
export type RewriteField = (typeof REWRITE_FIELDS)[number];

export const REWRITE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...REWRITE_FIELDS],
  properties: Object.fromEntries(REWRITE_FIELDS.map((f) => [f, { type: ["string", "null"], description: "הערך המשוכתב; null = אין ערך" }])),
} as const;
export const rewriteResultZ = z.object(Object.fromEntries(REWRITE_FIELDS.map((f) => [f, z.string().nullable()])) as Record<RewriteField, z.ZodNullable<z.ZodString>>);
export type RewriteResult = z.infer<typeof rewriteResultZ>;

/** "הוספת מידע ותיקון": the model returns operations, never whole fields; the server applies them to the saved text. */
export const REWRITE_OPS = ["add", "replace", "delete"] as const;
export const REWRITE_PATCH_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ops"],
  properties: {
    ops: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "op", "target", "anchor", "content", "reason"],
        properties: {
          field: strEnum(REWRITE_FIELDS),
          op: strEnum(REWRITE_OPS),
          target: nullable("string", { description: "replace / delete: the exact current text to change (verbatim); null replaces a short field entirely" }),
          anchor: nullable("string", { description: "add (description): an exact passage of the current text after which the addition goes; null = before the last (condition) paragraph" }),
          content: nullable("string", { description: "the new text (add / replace); null for delete" }),
          reason: nullable("string"),
        },
      },
    },
  },
} as const;
export const rewritePatchZ = z.object({
  ops: z.array(z.object({ field: z.enum(REWRITE_FIELDS), op: z.enum(REWRITE_OPS), target: z.string().nullable(), anchor: z.string().nullable(), content: z.string().nullable(), reason: z.string().nullable() })),
});
export type RewritePatch = z.infer<typeof rewritePatchZ>;
