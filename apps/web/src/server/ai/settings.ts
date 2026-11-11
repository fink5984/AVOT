import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "../db";
import { audit } from "../audit";
import { AppError } from "../errors";
import { asJson } from "../json";
import type { UserPrincipal } from "../auth/principal";
import { aiConfig, type AiConfig, type ProviderName } from "./config";
import { DEFAULT_ANALYSIS_PROMPT, DEFAULT_FULL_REWRITE_PROMPT, DEFAULT_MANUSCRIPT_PROMPT, DEFAULT_REWRITE_PATCH_PROMPT, composeInstructions, type InstructionParts } from "./catalog-prompt";
import { loadStyleLibrary, type StyleLibrary } from "./style-examples";
import { normalizeDashes } from "./text";
import { RESEARCH_BOUNDS, RESEARCH_DEFAULTS, type ResearchSettings } from "./research-core";

/*
 * The "הגדרות AI" tab: the ONE active provider + model for the whole organization, the reasoning level, the prompts
 * and the style examples. Stored in the database (no code change, push or deploy to change them); every save is an
 * immutable AiSettingsVersion. A run records the version it started with and keeps using it, so a later change only
 * affects new runs.
 *
 * What an edited prompt can NOT change (code, not text): the security / hyphen / Hebrew / JSON rules (CODE_RULES,
 * always appended), the answer schema and its validation, the protected fields, and the cleaning of every written text.
 * API keys stay in the server environment; this tab never sees them.
 */

/** Suggested models per provider (the field also accepts any other id: the provider rejects an unknown one on use). */
export const MODEL_PRESETS: Record<ProviderName, string[]> = {
  openai: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
  gemini: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3-flash-preview", "gemini-3.5-flash-lite"],
};

const OPENAI_LEVELS = ["none", "minimal", "low", "medium", "high"];

/** Reasoning levels a model accepts ([] = the model has no such setting). Gemini 3.5+ flash has no "minimal". */
export function reasoningOptions(provider: ProviderName, model: string): string[] {
  if (provider === "openai") return OPENAI_LEVELS;
  if (/^gemini-3\.(?:[5-9]|\d{2,})(?:\D|$)/.test(model)) return ["low", "medium", "high"];
  if (/^gemini-3/.test(model)) return ["minimal", "low", "medium", "high"];
  return [];
}

export interface AiSettingsValues {
  provider: ProviderName | null;
  model: string | null;
  reasoning: string | null;
  analysisPrompt: string | null;
  manuscriptPrompt: string | null;
  rewritePrompt: string | null;
  fullRewritePrompt: string | null;
  /** style examples JSON ({version, examples[]}); null = the file in the code */
  examples: unknown | null;
  /** external research (web search); null = the default (see RESEARCH_DEFAULTS) */
  researchEnabled: boolean | null;
  researchMaxSources: number | null;
  researchTimeoutSeconds: number | null;
  researchMaxSearches: number | null;
  researchMaxCostUsd: number | null;
  researchProvider: "auto" | "openai" | "gemini" | null;
}

const RESEARCH_KEYS = ["researchEnabled", "researchMaxSources", "researchTimeoutSeconds", "researchMaxSearches", "researchMaxCostUsd", "researchProvider"] as const;
const EMPTY: AiSettingsValues = { provider: null, model: null, reasoning: null, analysisPrompt: null, manuscriptPrompt: null, rewritePrompt: null, fullRewritePrompt: null, examples: null, researchEnabled: null, researchMaxSources: null, researchTimeoutSeconds: null, researchMaxSearches: null, researchMaxCostUsd: null, researchProvider: null };

const rInt = (key: keyof typeof RESEARCH_BOUNDS, label: string) => {
  const [lo, hi] = RESEARCH_BOUNDS[key];
  return z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v, ctx) => {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < lo || n > hi) {
        ctx.addIssue({ code: "custom", message: `${label}: מספר שלם בין ${lo} ל-${hi}` });
        return z.NEVER;
      }
      return n;
    });
};

const prompt = z
  .string()
  .max(40_000)
  .nullish()
  .transform((v) => {
    const t = v ? normalizeDashes(v).replace(/\r\n?/g, "\n").trim() : "";
    return t || null;
  });

export const aiSettingsSchema = z.object({
  provider: z.enum(["openai", "gemini"]).nullish().transform((v) => v ?? null),
  model: z
    .string()
    .trim()
    .max(100)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "מזהה מודל לא תקין")
    .nullish()
    .or(z.literal("").transform(() => null))
    .transform((v) => v ?? null),
  reasoning: z.string().trim().max(20).nullish().transform((v) => v || null),
  analysisPrompt: prompt,
  manuscriptPrompt: prompt,
  rewritePrompt: prompt,
  fullRewritePrompt: prompt,
  examples: z.unknown().nullish().transform((v) => v ?? null),
  researchEnabled: z.boolean().nullish().transform((v) => v ?? null),
  researchMaxSources: rInt("maxSources", "מספר מקורות מרבי"),
  researchTimeoutSeconds: rInt("timeoutSeconds", "מגבלת זמן למחקר (שניות)"),
  researchMaxSearches: rInt("maxSearches", "מספר חיפושים מרבי"),
  researchMaxCostUsd: z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v, ctx) => {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0.001 || n > 5) {
        ctx.addIssue({ code: "custom", message: "מגבלת עלות למחקר: בין 0.001 ל-5 דולר" });
        return z.NEVER;
      }
      return Math.round(n * 10000) / 10000;
    }),
  researchProvider: z.enum(["auto", "openai", "gemini"]).nullish().transform((v) => v ?? null),
  note: z.string().trim().max(300).nullish().transform((v) => v || null),
});

export type AiSettingsInput = z.infer<typeof aiSettingsSchema>;

/** Throws a Hebrew error for a combination the provider would reject. Returns the examples preview. */
export function validateSettings(v: AiSettingsValues, env: AiConfig = aiConfig()) {
  const provider = v.provider ?? env.BOOK_AI_PROVIDER;
  const model = v.model ?? (provider === "gemini" ? env.BOOK_AI_GEMINI_MODEL : env.BOOK_AI_OPENAI_MODEL);
  if (v.model && provider === "openai" && /^gemini/i.test(v.model)) throw new AppError("VALIDATION", "המודל שנבחר שייך ל-Gemini, אבל הספק הפעיל הוא OpenAI");
  if (v.model && provider === "gemini" && /^(gpt|o\d)/i.test(v.model)) throw new AppError("VALIDATION", "המודל שנבחר שייך ל-OpenAI, אבל הספק הפעיל הוא Gemini");
  if (v.reasoning) {
    const allowed = reasoningOptions(provider, model);
    if (!allowed.length) throw new AppError("VALIDATION", `למודל ${model} אין הגדרת רמת חשיבה`);
    if (!allowed.includes(v.reasoning)) throw new AppError("VALIDATION", `רמת החשיבה "${v.reasoning}" אינה נתמכת במודל ${model}. הרמות הנתמכות: ${allowed.join(", ")}`);
  }
  let examples: { version: string; count: number; skipped: StyleLibrary["skipped"] } | null = null;
  if (v.examples !== null) {
    if (typeof v.examples !== "object" || Array.isArray(v.examples) || !Array.isArray((v.examples as { examples?: unknown }).examples)) throw new AppError("VALIDATION", "ספריית הדוגמאות חייבת להיות אובייקט עם מערך examples");
    const lib = loadStyleLibrary(v.examples);
    if (lib.skipped.length) throw new AppError("VALIDATION", `דוגמאות לא תקינות: ${lib.skipped.map((s) => `#${s.index + 1}${s.id ? ` (${s.id})` : ""}: ${s.problem}`).join(" | ")}`);
    examples = { version: lib.version, count: lib.examples.length, skipped: lib.skipped };
  }
  return { provider, model, examples };
}

export interface ResolvedAiSettings {
  /** AiSettingsVersion.version; null = no row yet (the built-in defaults + environment) */
  version: number | null;
  provider: ProviderName;
  model: string;
  reasoning: string | null;
  /** the environment config with this provider / model / reasoning applied: what the provider factory reads */
  cfg: AiConfig;
  parts: InstructionParts;
  rewritePrompt: string;
  fullRewritePrompt: string;
  /** both main prompt parts are the built-in ones */
  defaultPrompts: boolean;
  /** sha256 (12 hex) of the composed instructions (without the examples): equal hash = same prompt */
  instructionHash: string;
  lib: StyleLibrary;
  stored: AiSettingsValues;
  /** the external research limits in force (defaults filled in) */
  research: ResearchSettings;
}

export const defaultTexts = () => ({
  analysisPrompt: DEFAULT_ANALYSIS_PROMPT,
  manuscriptPrompt: DEFAULT_MANUSCRIPT_PROMPT,
  rewritePrompt: DEFAULT_REWRITE_PATCH_PROMPT,
  fullRewritePrompt: DEFAULT_FULL_REWRITE_PROMPT,
});

export function resolveSettings(stored: AiSettingsValues, version: number | null, env: AiConfig = aiConfig()): ResolvedAiSettings {
  const provider = stored.provider ?? env.BOOK_AI_PROVIDER;
  const model = stored.model ?? (provider === "gemini" ? env.BOOK_AI_GEMINI_MODEL : env.BOOK_AI_OPENAI_MODEL);
  const options = reasoningOptions(provider, model);
  // an environment default (the old way to configure) applies only to its own provider and only if the model accepts it
  const envReasoning = provider === env.BOOK_AI_PROVIDER ? (provider === "gemini" ? env.BOOK_AI_GEMINI_THINKING : env.BOOK_AI_OPENAI_REASONING) || null : null;
  const reasoning = stored.reasoning ?? (envReasoning && options.includes(envReasoning) ? envReasoning : null);
  const cfg: AiConfig = {
    ...env,
    BOOK_AI_PROVIDER: provider,
    ...(provider === "gemini" ? { BOOK_AI_GEMINI_MODEL: model, BOOK_AI_GEMINI_THINKING: reasoning ?? "" } : { BOOK_AI_OPENAI_MODEL: model, BOOK_AI_OPENAI_REASONING: reasoning ?? "" }),
  };
  const parts: InstructionParts = { analysis: stored.analysisPrompt ?? DEFAULT_ANALYSIS_PROMPT, manuscript: stored.manuscriptPrompt ?? DEFAULT_MANUSCRIPT_PROMPT };
  return {
    version,
    provider,
    model,
    reasoning,
    cfg,
    parts,
    rewritePrompt: stored.rewritePrompt ?? DEFAULT_REWRITE_PATCH_PROMPT,
    fullRewritePrompt: stored.fullRewritePrompt ?? DEFAULT_FULL_REWRITE_PROMPT,
    defaultPrompts: stored.analysisPrompt === null && stored.manuscriptPrompt === null,
    instructionHash: createHash("sha256").update(composeInstructions(parts)).digest("hex").slice(0, 12),
    lib: loadStyleLibrary(stored.examples ?? undefined),
    stored,
    research: {
      enabled: stored.researchEnabled ?? RESEARCH_DEFAULTS.enabled,
      maxSources: stored.researchMaxSources ?? RESEARCH_DEFAULTS.maxSources,
      timeoutSeconds: stored.researchTimeoutSeconds ?? RESEARCH_DEFAULTS.timeoutSeconds,
      maxSearches: stored.researchMaxSearches ?? RESEARCH_DEFAULTS.maxSearches,
      maxCostUsd: stored.researchMaxCostUsd ?? RESEARCH_DEFAULTS.maxCostUsd,
      provider: stored.researchProvider ?? RESEARCH_DEFAULTS.provider,
    },
  };
}

type Row = {
  provider: string | null;
  model: string | null;
  reasoning: string | null;
  analysisPrompt: string | null;
  manuscriptPrompt: string | null;
  rewritePrompt: string | null;
  fullRewritePrompt: string | null;
  examples: Prisma.JsonValue | null;
  researchEnabled: boolean | null;
  researchMaxSources: number | null;
  researchTimeoutSeconds: number | null;
  researchMaxSearches: number | null;
  researchMaxCostUsd: Prisma.Decimal | null;
  researchProvider: string | null;
};
const fromRow = (r: Row | null): AiSettingsValues =>
  r
    ? {
        provider: (r.provider as ProviderName | null) ?? null,
        model: r.model,
        reasoning: r.reasoning,
        analysisPrompt: r.analysisPrompt,
        manuscriptPrompt: r.manuscriptPrompt,
        rewritePrompt: r.rewritePrompt,
        fullRewritePrompt: r.fullRewritePrompt,
        examples: r.examples ?? null,
        researchEnabled: r.researchEnabled,
        researchMaxSources: r.researchMaxSources,
        researchTimeoutSeconds: r.researchTimeoutSeconds,
        researchMaxSearches: r.researchMaxSearches,
        researchMaxCostUsd: r.researchMaxCostUsd === null ? null : Number(r.researchMaxCostUsd),
        researchProvider: (r.researchProvider as AiSettingsValues["researchProvider"]) ?? null,
      }
    : { ...EMPTY };

/** The organization's current settings, or the exact version a run started with. */
export async function getAiSettings(organizationId: string, version?: number | null): Promise<ResolvedAiSettings> {
  if (version === null) return resolveSettings({ ...EMPTY }, null);
  if (version !== undefined) {
    const v = await db.aiSettingsVersion.findUnique({ where: { organizationId_version: { organizationId, version } } });
    if (!v) throw new AppError("INTERNAL", `גרסת ההגדרות ${version} של הרצה זו לא נמצאה`);
    return resolveSettings(fromRow(v), version);
  }
  const row = await db.aiSettings.findUnique({ where: { organizationId } });
  return resolveSettings(fromRow(row), row && row.version > 0 ? row.version : null);
}

/** The settings version a new run is started with (null = the built-in defaults). */
export async function currentSettingsVersion(organizationId: string): Promise<number | null> {
  const row = await db.aiSettings.findUnique({ where: { organizationId }, select: { version: true } });
  return row && row.version > 0 ? row.version : null;
}

const KEYS = ["provider", "model", "reasoning", "analysisPrompt", "manuscriptPrompt", "rewritePrompt", "fullRewritePrompt", "examples", ...RESEARCH_KEYS] as const;

/** Saves a new version (the current row is replaced, the history keeps every version). Admin only (checked by the route). */
export async function saveAiSettings(user: UserPrincipal, raw: unknown, opts: { note?: string | null } = {}) {
  const input = aiSettingsSchema.parse(raw);
  const values: AiSettingsValues = {
    provider: input.provider,
    model: input.model,
    reasoning: input.reasoning,
    analysisPrompt: input.analysisPrompt,
    manuscriptPrompt: input.manuscriptPrompt,
    rewritePrompt: input.rewritePrompt,
    fullRewritePrompt: input.fullRewritePrompt,
    examples: input.examples,
    researchEnabled: input.researchEnabled,
    researchMaxSources: input.researchMaxSources,
    researchTimeoutSeconds: input.researchTimeoutSeconds,
    researchMaxSearches: input.researchMaxSearches,
    researchMaxCostUsd: input.researchMaxCostUsd,
    researchProvider: input.researchProvider,
  };
  validateSettings(values);
  return db.$transaction(async (tx) => {
    const prev = await tx.aiSettings.findUnique({ where: { organizationId: user.organizationId } });
    const before = fromRow(prev);
    const changed = KEYS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(values[k]));
    if (prev && !changed.length) throw new AppError("CONFLICT", "לא בוצע שינוי בהגדרות");
    const version = (prev?.version ?? 0) + 1;
    const data = {
      provider: values.provider,
      model: values.model,
      reasoning: values.reasoning,
      analysisPrompt: values.analysisPrompt,
      manuscriptPrompt: values.manuscriptPrompt,
      rewritePrompt: values.rewritePrompt,
      fullRewritePrompt: values.fullRewritePrompt,
      examples: values.examples === null ? Prisma.DbNull : asJson(values.examples),
      researchEnabled: values.researchEnabled,
      researchMaxSources: values.researchMaxSources,
      researchTimeoutSeconds: values.researchTimeoutSeconds,
      researchMaxSearches: values.researchMaxSearches,
      researchMaxCostUsd: values.researchMaxCostUsd,
      researchProvider: values.researchProvider,
    };
    await tx.aiSettings.upsert({ where: { organizationId: user.organizationId }, create: { organizationId: user.organizationId, version, updatedById: user.userId, ...data }, update: { version, updatedById: user.userId, ...data } });
    await tx.aiSettingsVersion.create({ data: { organizationId: user.organizationId, version, note: opts.note ?? input.note ?? null, createdById: user.userId, ...data } });
    await audit(user, { action: "ai.settings_changed", entityType: "settings", entityId: user.organizationId, data: asJson({ version, changed, provider: values.provider, model: values.model, reasoning: values.reasoning, research: { enabled: values.researchEnabled, maxSources: values.researchMaxSources, timeoutSeconds: values.researchTimeoutSeconds, maxSearches: values.researchMaxSearches, maxCostUsd: values.researchMaxCostUsd, provider: values.researchProvider } }) }, tx);
    return { version, changed };
  });
}

/** Puts an earlier version back as a NEW version (history is never rewritten). */
export async function restoreAiSettingsVersion(user: UserPrincipal, version: number) {
  const v = await db.aiSettingsVersion.findUnique({ where: { organizationId_version: { organizationId: user.organizationId, version } } });
  if (!v) throw new AppError("NOT_FOUND", "גרסת ההגדרות לא נמצאה");
  const values = fromRow(v);
  return saveAiSettings(user, { ...values }, { note: `שחזור גרסה ${version}` });
}

export async function listAiSettingsVersions(organizationId: string, take = 30) {
  const rows = await db.aiSettingsVersion.findMany({ where: { organizationId }, orderBy: { version: "desc" }, take });
  const users = new Map((await db.user.findMany({ where: { id: { in: rows.map((r) => r.createdById).filter((x): x is string => !!x) }, organizationId }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdById ? (users.get(r.createdById) ?? null) : null,
    note: r.note,
    provider: r.provider,
    model: r.model,
    reasoning: r.reasoning,
    customized: [r.analysisPrompt && "פרומפט ניתוח", r.manuscriptPrompt && "כתבי יד", r.rewritePrompt && "תיקון ממוקד", r.fullRewritePrompt && "שכתוב מלא", r.examples && "דוגמאות", (r.researchEnabled !== null || r.researchMaxSources !== null || r.researchTimeoutSeconds !== null || r.researchMaxSearches !== null || r.researchMaxCostUsd !== null || r.researchProvider !== null) && "מחקר חיצוני"].filter(Boolean) as string[],
  }));
}

/** What the settings tab shows: the stored values, the effective ones, and which keys exist in the server environment. */
export async function getSettingsScreen(organizationId: string) {
  const row = await db.aiSettings.findUnique({ where: { organizationId } });
  const stored = fromRow(row);
  const resolved = resolveSettings(stored, row && row.version > 0 ? row.version : null);
  const env = aiConfig();
  return {
    version: resolved.version,
    stored,
    effective: { provider: resolved.provider, model: resolved.model, reasoning: resolved.reasoning, examplesVersion: resolved.lib.version, examplesCount: resolved.lib.examples.length, instructionHash: resolved.instructionHash, research: resolved.research },
    researchDefaults: RESEARCH_DEFAULTS,
    researchBounds: RESEARCH_BOUNDS,
    defaults: defaultTexts(),
    defaultExamples: loadStyleLibrary().version,
    keys: { openai: !!env.OPENAI_API_KEY, gemini: !!env.GEMINI_API_KEY },
    presets: MODEL_PRESETS,
    reasoning: { openai: reasoningOptions("openai", ""), gemini3: ["minimal", "low", "medium", "high"], gemini35: ["low", "medium", "high"] },
    versions: await listAiSettingsVersions(organizationId),
  };
}
