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

/* ───────────── automatic bold (AI) and carrying formatting across a text edit ───────────── */

/** Typographic variants that look the same to a reader: folded 1:1 (same length) so positions stay valid. */
const FOLD: Record<string, string> = { "״": '"', "”": '"', "“": '"', "„": '"', "׳": "'", "’": "'", "‘": "'", "–": "-", "—": "-", "־": "-", " ": " " };
const fold = (s: string) => s.replace(/[״”“„׳’‘–—־ ]/g, (c) => FOLD[c] ?? c);
/** Hebrew points / cantillation and combining marks: they belong to the letter before them */
const COMBINING = /[֑-ׇֽֿׁׂׅׄ̀-ͯ]/;
const WORD_CHAR = /[\p{L}\p{N}]/u;

export const BOLD_LIMITS = { maxPhrases: 8, minChars: 3, maxPhraseChars: 200, maxShare: 0.4 } as const;

export interface BoldOutcome {
  /** null = nothing was bolded (the text then stays plain) */
  segments: Segment[] | null;
  applied: string[];
  skipped: { phrase: string; reason: string }[];
}

/**
 * Turns the exact phrases the model asked to emphasise into bold segments of `text`. The text itself is never
 * touched: a phrase is located by exact comparison (typographic quotes / dashes folded), never by character offsets
 * given by the model, and a phrase that cannot be found exactly is skipped and reported. The result always spells
 * `text`. Few, short, whole-word phrases only: never a whole paragraph and never more than BOLD_LIMITS.maxShare of the text.
 */
export function boldSegments(text: string, phrases: readonly string[], opts: { ignoreShare?: boolean } = {}): BoldOutcome {
  const out: BoldOutcome = { segments: null, applied: [], skipped: [] };
  if (!text) return out;
  const hay = fold(text);
  const paragraphs: [number, number][] = [];
  for (let at = 0; at <= text.length; ) {
    const end = text.indexOf("\n\n", at);
    paragraphs.push([at, end < 0 ? text.length : end]);
    if (end < 0) break;
    at = end + 2;
  }
  const ranges: [number, number][] = [];
  const seen = new Set<string>();
  for (const raw of phrases.slice(0, 40)) {
    const phrase = raw.trim();
    const skip = (reason: string) => out.skipped.push({ phrase: phrase.slice(0, 80), reason });
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    if (out.applied.length >= BOLD_LIMITS.maxPhrases) {
      skip("יותר מדי הדגשות");
      continue;
    }
    if (phrase.length < BOLD_LIMITS.minChars) {
      skip("קצר מדי");
      continue;
    }
    if (phrase.length > BOLD_LIMITS.maxPhraseChars) {
      skip("ארוך מדי");
      continue;
    }
    const needle = fold(phrase);
    let found = -1;
    for (let from = 0; ; ) {
      const i = hay.indexOf(needle, from);
      if (i < 0) break;
      const before = i > 0 ? text[i - 1]! : "";
      const after = i + needle.length < text.length ? text[i + needle.length]! : "";
      const startsOk = !before || !WORD_CHAR.test(before) || !WORD_CHAR.test(needle[0]!);
      const endsOk = !after || !WORD_CHAR.test(after) || !WORD_CHAR.test(needle[needle.length - 1]!);
      if (startsOk && endsOk) {
        found = i;
        break;
      }
      from = i + 1;
    }
    if (found < 0) {
      skip("הביטוי לא נמצא בטקסט במדויק");
      continue;
    }
    let start = found;
    let end = found + needle.length;
    while (start > 0 && COMBINING.test(text[start]!)) start--;
    while (end < text.length && COMBINING.test(text[end]!)) end++;
    const para = paragraphs.find(([a, b]) => start >= a && start <= b);
    if (para && para[1] - para[0] > 80 && end - start >= (para[1] - para[0]) * 0.9) {
      skip("פסקה שלמה");
      continue;
    }
    if (end - start >= text.length * 0.85) {
      skip("כל הטקסט");
      continue;
    }
    if (ranges.some(([a, b]) => start < b && end > a)) {
      skip("חופף להדגשה אחרת");
      continue;
    }
    ranges.push([start, end]);
    out.applied.push(text.slice(start, end));
  }
  // the whole emphasis stays small: the longest phrases go first when the limit is exceeded
  let total = ranges.reduce((n, [a, b]) => n + (b - a), 0);
  while (!opts.ignoreShare && total > text.length * BOLD_LIMITS.maxShare && ranges.length) {
    let longest = 0;
    ranges.forEach(([a, b], i) => {
      if (b - a > ranges[longest]![1] - ranges[longest]![0]) longest = i;
    });
    const [a, b] = ranges.splice(longest, 1)[0]!;
    const dropped = text.slice(a, b);
    out.applied = out.applied.filter((p) => p !== dropped);
    out.skipped.push({ phrase: dropped.slice(0, 80), reason: "יותר מדי טקסט מודגש" });
    total -= b - a;
  }
  if (!ranges.length) return out;
  ranges.sort((x, y) => x[0] - y[0]);
  const segs: Segment[] = [];
  let pos = 0;
  for (const [a, b] of ranges) {
    if (a > pos) segs.push({ t: text.slice(pos, a) });
    segs.push({ t: text.slice(a, b), b: true });
    pos = b;
  }
  if (pos < text.length) segs.push({ t: text.slice(pos) });
  const merged = mergeSegments(segs);
  // the safety net: formatting must spell exactly the text
  if (plainText(merged) !== text) return { segments: null, applied: [], skipped: [...out.skipped, { phrase: "", reason: "ההדגשות לא תאמו את הטקסט ובוטלו" }] };
  out.segments = merged;
  return out;
}

const TOKEN = /\s+|[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]/gu;
const MAX_DIFF_TOKENS = 4000;

type CharStyle = Omit<Segment, "t">;

/**
 * The formatting of `oldText` carried over to `newText` after an edit (an AI addition or correction): characters the
 * edit left untouched keep their bold / underline / color exactly, inserted or replaced text is plain. The result
 * always spells `newText`. When the old segments do not describe `oldText` there is no formatting to carry.
 */
export function carryFormat(oldText: string, oldSegs: Segment[] | null | undefined, newText: string): Segment[] {
  if (!newText) return [];
  if (!oldSegs || !hasFormatting(oldSegs) || plainText(oldSegs) !== oldText) return [{ t: newText }];
  const styles: CharStyle[] = [];
  for (const s of oldSegs) for (let i = 0; i < s.t.length; i++) styles.push({ b: s.b, u: s.u, c: s.c });
  const a = oldText.match(TOKEN) ?? [];
  const b = newText.match(TOKEN) ?? [];
  const next: (CharStyle | null)[] = new Array(newText.length).fill(null);
  const offsets = (toks: string[]) => {
    const o: number[] = [];
    let p = 0;
    for (const t of toks) {
      o.push(p);
      p += t.length;
    }
    return o;
  };
  const aOff = offsets(a);
  const bOff = offsets(b);
  const copy = (ai: number, bi: number) => {
    for (let k = 0; k < a[ai]!.length; k++) next[bOff[bi]! + k] = styles[aOff[ai]! + k]!;
  };
  // common head and tail first (an edit is usually local), then a token diff of the middle
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  for (let i = 0; i < head; i++) copy(i, i);
  for (let i = 0; i < tail; i++) copy(a.length - 1 - i, b.length - 1 - i);
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  if (am.length && bm.length && am.length <= MAX_DIFF_TOKENS && bm.length <= MAX_DIFF_TOKENS) {
    const w = bm.length + 1;
    const L = new Uint16Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--) for (let j = bm.length - 1; j >= 0; j--) L[i * w + j] = am[i] === bm[j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < am.length && j < bm.length) {
      if (am[i] === bm[j]) {
        copy(head + i, head + j);
        i++;
        j++;
      } else if (L[(i + 1) * w + j]! >= L[i * w + j + 1]!) i++;
      else j++;
    }
  }
  const segs: Segment[] = [];
  for (let i = 0; i < newText.length; i++) segs.push(styled(newText[i]!, next[i] ?? {}));
  const merged = mergeSegments(segs);
  return plainText(merged) === newText ? merged : [{ t: newText }];
}

/** Bold added on top of existing segments inside `within` of `text` (an inserted passage); existing styles stay. */
export function addBoldPhrases(text: string, segs: Segment[], phrases: readonly string[], within: [number, number] | null = null): Segment[] {
  if (!phrases.length) return segs;
  const region = within ? text.slice(within[0], within[1]) : text;
  const r = boldSegments(region, phrases, { ignoreShare: true });
  if (!r.segments) return segs;
  let pos = within ? within[0] : 0;
  let out = segs.length ? segs : [{ t: text }];
  if (plainText(out) !== text) return segs;
  for (const s of r.segments) {
    if (s.b) out = applyStyle(out, pos, pos + s.t.length, { b: true });
    pos += s.t.length;
  }
  return plainText(out) === text ? out : segs;
}
