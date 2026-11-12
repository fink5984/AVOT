/**
 * Shared text handling for list search (client and server). A list search splits what was typed into words; every word
 * must match somewhere in the row, in any order ("נועם אלימלך" finds "אלימלך, נועם"). No dependencies, so the screens
 * and the services use the very same rules.
 */

// Hebrew points and cantillation marks, bidi controls and zero-width characters: invisible in a text box, but they break a match
const INVISIBLE = /[\u0591-\u05C7\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** What was typed, cleaned: invisible marks removed, every kind of space (including no-break) collapsed to one, trimmed. */
export function normalizeQuery(raw: string | null | undefined): string {
  return (raw ?? "").normalize("NFC").replace(INVISIBLE, "").replace(/[\s\u00A0]+/g, " ").trim().slice(0, 200);
}

/** The words of a search, at most 6 (more only slow the database down), each at most 60 characters. */
export function searchTokens(raw: string | null | undefined): string[] {
  const q = normalizeQuery(raw);
  if (!q) return [];
  return [...new Set(q.split(" "))].filter(Boolean).slice(0, 6).map((t) => t.slice(0, 60));
}

/** The same matching in memory (for lists that are already in the browser): every word is found in at least one field. */
export function matchesTokens(fields: (string | number | null | undefined)[], raw: string | null | undefined): boolean {
  const tokens = searchTokens(raw);
  if (tokens.length === 0) return true;
  const hay = fields.map((f) => normalizeQuery(f == null ? "" : String(f)).toLowerCase());
  return tokens.every((tok) => hay.some((h) => h.includes(tok.toLowerCase())));
}

/** "a,b,c" (or a repeated parameter) → ["a","b","c"], empty items dropped, no duplicates. Used for multi-value filters in the URL. */
export function parseList(v: string | string[] | null | undefined): string[] {
  const parts = Array.isArray(v) ? v : v ? [v] : [];
  return [...new Set(parts.flatMap((p) => p.split(",")).map((s) => s.trim()).filter(Boolean))];
}

/** parseList, keeping only values from an allowed set (a hand-edited URL can never reach the database as a filter value). */
export function parseEnumList<T extends string>(v: string | string[] | null | undefined, allowed: readonly T[]): T[] {
  return parseList(v).filter((x): x is T => (allowed as readonly string[]).includes(x));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const parseIdList = (v: string | string[] | null | undefined): string[] => parseList(v).filter((x) => UUID.test(x)).slice(0, 50);
