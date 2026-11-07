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

export const ANALYSIS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["itemType", "identification", "fields", "catalog", "findings", "imagesReviewed", "requiresReview", "warnings"],
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
    findings: { type: "array", items: findingSchema, description: "signatures, dedications, stamps, handwritten notes and other special findings" },
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

export const analysisResultZ = z.object({
  itemType: z.object({ value: z.enum(ITEM_TYPES), confidence: z.enum(CONFIDENCES), note: z.string().nullable() }),
  identification: z.object({
    summary: z.string(),
    existingTitleCheck: z.enum(["matches", "more_precise_available", "contradicts", "no_existing_title", "cannot_check"]),
    conflicts: z.array(z.string()),
  }),
  fields: z.object(Object.fromEntries(AI_FIELD_NAMES.map((f) => [f, fieldZ])) as Record<AiFieldName, typeof fieldZ>),
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
