/*
 * Text rules for what the AI writes into the item. Pure functions (no server-only): unit tested.
 *
 * Mandatory house rule: only the keyboard hyphen "-" (U+002D). Em dash, en dash and the other dash look-alikes are
 * replaced before anything is saved. Transcriptions (what is literally written on a title page, a signature, a stamp)
 * are evidence and are stored untouched in the run's result; only the prose written into item fields is normalised.
 */

/** U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash, U+2013 en dash, U+2014 em dash, U+2015 horizontal bar,
 *  U+2212 minus, U+FE58 / U+FE63 / U+FF0D small and full-width hyphen-minus. Hebrew maqaf (U+05BE) is a letter-level
 *  mark of Hebrew orthography and is left alone. */
const DASHES = /[‐-―−﹘﹣－]/g;

export function normalizeDashes(text: string): string {
  // " — " and "—" both become " - " / "-"; spacing around the dash is kept as written
  return text.replace(DASHES, "-");
}

export function hasForbiddenDash(text: string): boolean {
  DASHES.lastIndex = 0;
  const found = DASHES.test(text);
  DASHES.lastIndex = 0;
  return found;
}

/** Trims, normalises line breaks and dashes, collapses runs of blank lines, clamps to `max` characters. */
export function cleanAiText(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  let s = normalizeDashes(String(text)).replace(/\r\n?/g, "\n");
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!s) return null;
  if (s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, "").trimEnd();
  return s || null;
}

/** Same value for comparison purposes (whitespace and dash variants ignored). */
export function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (v: string | null | undefined) => normalizeDashes(v ?? "").replace(/\s+/g, " ").trim();
  return n(a) === n(b);
}

/** Target of a catalog headline: 5-12 words, about 80 characters. Beyond these limits a person should shorten it. */
export const HEADLINE_TARGET = { words: 12, chars: 80, hardWords: 15, hardChars: 110, maxSeparators: 2 } as const;

/** Why a headline is not short and strong enough (null = fine). Pure: the text is never changed, only flagged. */
export function headlineIssue(headline: string | null | undefined): string | null {
  const h = (headline ?? "").replace(/\s+/g, " ").trim();
  if (!h) return null;
  const words = h.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const separators = (h.match(/ - /g) ?? []).length;
  if (words > HEADLINE_TARGET.hardWords || h.length > HEADLINE_TARGET.hardChars) return `הכותרת הקטלוגית ארוכה (${words} מילים, ${h.length} תווים; היעד עד ${HEADLINE_TARGET.words} מילים וכ-${HEADLINE_TARGET.chars} תווים). כדאי לקצר אותה כך שהמאפיין החשוב ביותר יופיע בתחילתה.`;
  if (separators > HEADLINE_TARGET.maxSeparators) return "הכותרת הקטלוגית היא רשימת פרטים מופרדת במקפים. כדאי להשאיר בה את המאפיין החשוב ביותר ולהעביר את פרטי הדפוס לתיאור.";
  return null;
}
