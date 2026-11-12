/**
 * Money in AVOT is US dollars, kept exact: amounts travel as strings with two decimals ("150.00") and live in
 * DECIMAL(12,2) columns. Floats are never used for sums (see addMoney). "No amount" is null, never 0.
 */

/** Parses what a person typed or a file held ("$1,250", "150", "150.5"). Returns the exact "1250.00" form, or null for empty. Throws a Hebrew message for anything else. */
export function parseUsd(raw: unknown, opts: { allowZero?: boolean } = {}): string | null {
  if (raw === null || raw === undefined) return null;
  let s = typeof raw === "number" ? (Number.isFinite(raw) ? String(raw) : "") : String(raw);
  s = s.replace(/[\s$]/g, "").replace(/,(?=\d{3}(\D|$))/g, "");
  if (s === "") return null;
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(s)) {
    // 12.345 from a spreadsheet is a typing mistake, not a price to round silently
    throw new Error("הסכום אינו תקין. יש להזין מספר בדולרים, עד שתי ספרות אחרי הנקודה");
  }
  const [whole, frac = ""] = s.split(".");
  const out = `${whole!.replace(/^0+(?=\d)/, "")}.${frac.padEnd(2, "0")}`;
  if (!opts.allowZero && Number(out) <= 0) throw new Error("הסכום חייב להיות גדול מאפס. כדי להשאיר ללא מחיר, מחקו את הערך");
  return out;
}

const toCents = (v: string) => {
  const neg = v.startsWith("-");
  const [w, f = ""] = v.replace("-", "").split(".");
  const c = BigInt(w!) * 100n + BigInt(f.padEnd(2, "0").slice(0, 2));
  return neg ? -c : c;
};
const fromCents = (c: bigint): string => (c < 0n ? `-${fromCents(-c)}` : `${c / 100n}.${String(c % 100n).padStart(2, "0")}`);

/** exact decimal sum of money strings (null counts as nothing) */
export function addMoney(...values: (string | null | undefined)[]): string {
  return fromCents(values.reduce<bigint>((a, v) => a + (v ? toCents(v) : 0n), 0n));
}
export function subMoney(a: string, b: string): string {
  return fromCents(toCents(a) - toCents(b));
}
export function cmpMoney(a: string, b: string): number {
  const d = toCents(a) - toCents(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

/** "$1,250" — whole dollars without ".00", cents only when present; null → fallback */
export function formatUsd(v: string | number | null | undefined, fallback = "לא הוגדר"): string {
  if (v === null || v === undefined || v === "") return fallback;
  const s = typeof v === "number" ? v.toFixed(2) : v;
  const [w, f = "00"] = s.split(".");
  const neg = w!.startsWith("-");
  const grouped = w!.replace("-", "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${grouped}${f === "00" ? "" : `.${f}`}`;
}
