import { z } from "zod";

/*
 * Character formatting (bold, underline, color) of a lot's texts.
 *
 * The plain text stays in its own column (shortDescription / description) and remains the source of truth for
 * search, exports, AI and versions. The formatting is kept beside it, as segments whose concatenation IS that text.
 * When the text is changed by any other path (AI, import, a plain editor) the segments no longer match and the text
 * simply shows unformatted - formatting can never alter or hide the words themselves.
 */

export interface Segment {
  t: string;
  b?: true;
  u?: true;
  /** #rrggbb */
  c?: string;
}

/** field name -> formatted segments */
export type TextFormat = Partial<Record<string, Segment[]>>;
/** only the catalog description is formattable: the long text of a lot, and the catalog draft of a book in inventory */
export const LOT_FORMAT_FIELDS = ["description"] as const;
export const ITEM_FORMAT_FIELDS = ["catalogDescription"] as const;

export interface StylePatch {
  b?: boolean;
  u?: boolean;
  /** null removes the color */
  c?: string | null;
}

/** The colors offered in the toolbar (dark enough to read on paper). */
export const TEXT_COLORS = [
  { value: "#b42318", label: "אדום" },
  { value: "#1d4ed8", label: "כחול" },
  { value: "#15803d", label: "ירוק" },
  { value: "#9a6b00", label: "זהב" },
  { value: "#7e22ce", label: "סגול" },
  { value: "#6b6b6b", label: "אפור" },
] as const;

const COLOR = /^#[0-9a-f]{6}$/i;

export const segmentsSchema = z
  .array(
    z.object({
      t: z.string().max(20000),
      b: z.literal(true).optional(),
      u: z.literal(true).optional(),
      c: z.string().regex(COLOR).optional(),
    }),
  )
  .max(5000);

export const textFormatSchema = z.object({
  description: segmentsSchema.nullish(),
});

export const itemTextFormatSchema = z.object({
  catalogDescription: segmentsSchema.nullish(),
});

const sameStyle = (a: Segment, b: Segment) => !!a.b === !!b.b && !!a.u === !!b.u && (a.c ?? "") === (b.c ?? "");

function styled(t: string, s: Omit<Segment, "t">): Segment {
  const out: Segment = { t };
  if (s.b) out.b = true;
  if (s.u) out.u = true;
  if (s.c && COLOR.test(s.c)) out.c = s.c.toLowerCase();
  return out;
}

/** Drops empty segments and joins neighbours of the same style. */
export function mergeSegments(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    if (!s.t) continue;
    const last = out[out.length - 1];
    if (last && sameStyle(last, s)) last.t += s.t;
    else out.push(styled(s.t, s));
  }
  return out;
}

export const plainText = (segs: Segment[]) => segs.map((s) => s.t).join("");

export const hasFormatting = (segs: Segment[] | null | undefined) => !!segs?.some((s) => s.t && (s.b || s.u || s.c));

/** The segments to show for a text: its formatting while it still matches, else the plain text. */
export function segmentsFor(text: string | null | undefined, segs: Segment[] | null | undefined): Segment[] {
  const value = text ?? "";
  if (segs && hasFormatting(segs) && plainText(segs) === value) return mergeSegments(segs);
  return value ? [{ t: value }] : [];
}

/** Reads the stored column defensively (it is JSON written by this module, but never trusted blindly). */
export function readTextFormat(raw: unknown, fields: readonly string[] = LOT_FORMAT_FIELDS): TextFormat {
  const shape = Object.fromEntries(fields.map((f) => [f, segmentsSchema.nullish()]));
  const parsed = z.object(shape).safeParse(raw ?? {});
  if (!parsed.success) return {};
  const data = parsed.data as Record<string, Segment[] | null | undefined>;
  const out: TextFormat = {};
  for (const k of fields) {
    const v = data[k];
    if (v && hasFormatting(v)) out[k] = mergeSegments(v);
  }
  return out;
}

/** A book's stored formatting as the review panel's single string value (null = none). */
export function serializeItemFormat(raw: unknown): string | null {
  const f = readTextFormat(raw, ITEM_FORMAT_FIELDS);
  return Object.keys(f).length ? JSON.stringify(f) : null;
}

/** True when two segment lists spell the same text with the same styles. */
export function sameSegments(a: Segment[], b: Segment[]): boolean {
  const x = mergeSegments(a);
  const y = mergeSegments(b);
  return x.length === y.length && x.every((s, i) => s.t === y[i]!.t && sameStyle(s, y[i]!));
}

/** Removes leading and trailing whitespace, as the server trims the plain text. */
export function trimSegments(segs: Segment[]): Segment[] {
  const out = mergeSegments(segs).map((s) => ({ ...s }));
  while (out.length && !out[0]!.t.trimStart()) out.shift();
  if (out[0]) out[0].t = out[0].t.trimStart();
  while (out.length && !out[out.length - 1]!.t.trimEnd()) out.pop();
  const last = out[out.length - 1];
  if (last) last.t = last.t.trimEnd();
  return out;
}

/** Splits the segments so that `at` falls on a segment boundary. */
function splitAt(segs: Segment[], at: number): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (const s of segs) {
    const end = pos + s.t.length;
    if (at > pos && at < end) {
      out.push({ ...s, t: s.t.slice(0, at - pos) }, { ...s, t: s.t.slice(at - pos) });
    } else out.push({ ...s });
    pos = end;
  }
  return out;
}

/** Applies a style to the characters [start, end). */
export function applyStyle(segs: Segment[], start: number, end: number, patch: StylePatch): Segment[] {
  if (end <= start) return mergeSegments(segs);
  const parts = splitAt(splitAt(segs, start), end);
  let pos = 0;
  const out = parts.map((s) => {
    const from = pos;
    pos += s.t.length;
    if (from < start || from >= end) return s;
    const next: Segment = { ...s };
    if (patch.b !== undefined) {
      if (patch.b) next.b = true;
      else delete next.b;
    }
    if (patch.u !== undefined) {
      if (patch.u) next.u = true;
      else delete next.u;
    }
    if (patch.c !== undefined) {
      if (patch.c) next.c = patch.c;
      else delete next.c;
    }
    return next;
  });
  return mergeSegments(out);
}

/** Replaces the characters [start, end) with plain typing that takes the style of the character before it. */
export function replaceRange(segs: Segment[], start: number, end: number, text: string): Segment[] {
  const parts = splitAt(splitAt(segs, start), end);
  const out: Segment[] = [];
  let pos = 0;
  let inserted = false;
  let before: Segment | undefined;
  for (const s of parts) {
    const from = pos;
    pos += s.t.length;
    if (from < start) {
      out.push(s);
      before = s;
      continue;
    }
    if (!inserted) {
      out.push({ ...(before ?? s), t: text });
      inserted = true;
    }
    if (from >= end) out.push(s);
  }
  if (!inserted) out.push({ ...(before ?? { t: "" }), t: text });
  return mergeSegments(out);
}

/** The word (run of non-space characters) around a caret, as [start, end); empty when the caret is on a space. */
export function wordAt(text: string, at: number): [number, number] {
  let s = at;
  let e = at;
  while (s > 0 && !/\s/.test(text[s - 1]!)) s--;
  while (e < text.length && !/\s/.test(text[e]!)) e++;
  return [s, e];
}

/** True when every character of [start, end) carries the flag (an empty range never does). */
export function rangeHas(segs: Segment[], start: number, end: number, key: "b" | "u"): boolean {
  if (end <= start) return false;
  let pos = 0;
  let seen = false;
  for (const s of segs) {
    const from = pos;
    pos += s.t.length;
    if (pos <= start || from >= end) continue;
    seen = true;
    if (!s[key]) return false;
  }
  return seen;
}

/**
 * The formatting to store for a field after a save: kept only when it describes exactly the stored (trimmed) text,
 * otherwise dropped. Returns undefined when the field carries no formatting.
 */
export function formatToStore(segs: Segment[] | null | undefined, storedText: string | null): Segment[] | undefined {
  if (!segs || !storedText || !hasFormatting(segs)) return undefined;
  const trimmed = trimSegments(segs);
  return plainText(trimmed) === storedText ? trimmed : undefined;
}
