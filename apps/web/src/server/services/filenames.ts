/** Filesystem-safe names for ZIP entries (Windows + macOS + Linux). */

const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f\u007f‎‏‪-‮]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export function safeSegment(input: string, maxLength = 60): string {
  let s = input.normalize("NFC").replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/[. ]+$/g, "");
  if (s.length > maxLength) s = s.slice(0, maxLength).trim();
  if (!s || RESERVED.test(s)) s = `_${s}`;
  return s;
}

/** Returns a unique variant of `name` within `used`, appending " (2)", " (3)", … */
export function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  let i = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${name} (${i++})`;
  used.add(candidate.toLowerCase());
  return candidate;
}
