import { createHash } from "node:crypto";
import { z } from "zod";
import library from "./catalog-style-examples.json";

/*
 * The writing-style library (catalog-style-examples.json), separate from the main prompt. Every ACTIVE example is sent
 * with every analysis: no selection by category, the model learns the house style from the whole set.
 * An empty or partial file never breaks the engine: invalid entries are skipped and reported in the run's warnings
 * (never dropped silently), and zero examples is a valid library.
 */

const exampleZ = z.object({
  id: z.string().min(1),
  active: z.boolean().default(true),
  title: z.string().default(""),
  itemType: z.string().optional(),
  sourceUrl: z.string().nullish(),
  sourceNote: z.string().nullish(),
  /** optional input data the description was written from (input → desired output examples) */
  input: z.record(z.unknown()).nullish(),
  headline: z.string().nullish(),
  description: z.string().min(1),
  styleNote: z.string().nullish(),
  updatedAt: z.string().nullish(),
});
export type StyleExample = z.infer<typeof exampleZ>;

export interface StyleLibrary {
  version: string;
  /** sha256 (first 16 hex) of the active examples as sent: changes whenever their content changes */
  hash: string;
  examples: StyleExample[];
  /** entries that were not valid and therefore not sent */
  skipped: { index: number; id: string | null; problem: string }[];
  /** the rendered block appended to the instructions ("" without examples) */
  block: string;
}

export function loadStyleLibrary(raw: unknown = library): StyleLibrary {
  const root = (raw && typeof raw === "object" ? raw : {}) as { version?: unknown; examples?: unknown };
  const version = typeof root.version === "string" && root.version ? root.version : "unversioned";
  const list = Array.isArray(root.examples) ? root.examples : [];
  const examples: StyleExample[] = [];
  const skipped: StyleLibrary["skipped"] = [];
  const seen = new Set<string>();
  list.forEach((entry, index) => {
    const r = exampleZ.safeParse(entry);
    if (!r.success) {
      const id = entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string" ? (entry as { id: string }).id : null;
      skipped.push({ index, id, problem: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      return;
    }
    if (seen.has(r.data.id)) {
      skipped.push({ index, id: r.data.id, problem: "מזהה כפול" });
      return;
    }
    seen.add(r.data.id);
    if (r.data.active) examples.push(r.data);
  });
  const block = renderExamples(examples);
  const hash = createHash("sha256").update(block).digest("hex").slice(0, 16);
  return { version, hash, examples, skipped, block };
}

function renderExamples(examples: StyleExample[]): string {
  if (!examples.length) return "";
  const parts = examples.map((e, i) => {
    const lines = [`## דוגמה ${i + 1} (${e.id})${e.title ? ` - ${e.title}` : ""}`];
    if (e.input && Object.keys(e.input).length) lines.push(`נתוני קלט:\n${JSON.stringify(e.input, null, 2)}`);
    if (e.headline) lines.push(`כותרת:\n${e.headline}`);
    lines.push(`תיאור:\n${e.description}`);
    if (e.styleNote) lines.push(`הערת סגנון: ${e.styleNote}`);
    return lines.join("\n\n");
  });
  return [
    "# דוגמאות כתיבה",
    "הדוגמאות הבאות מלמדות את סגנון הכתיבה, המבנה והאורך המקובלים בבית המכירות. אין להעתיק מהן עובדות, שמות, שנים או חתימות: הן אינן מתארות את הפריט שלפניך.",
    ...parts,
  ].join("\n\n");
}

/** Rough token estimate for budgeting before a request (Hebrew text ≈ 2.5 characters per token). Real counts come from the provider. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}
