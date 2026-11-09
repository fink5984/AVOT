import { AI_MAX_LENGTH, stripImageIds, stripMeasurements } from "./mapper";
import { REWRITE_FIELDS, type RewriteField, type RewritePatch } from "./schema";
import { normalizeDashes } from "./text";

/*
 * "הוספת מידע ותיקון": the model returns operations, the server applies them to the SAVED text. Whatever an operation
 * does not name stays byte-identical (no field is returned that did not change, and inside a long text only the
 * edited sentence or paragraph moves). An operation that cannot be verified against the current text is skipped and
 * reported, never guessed. Pure functions: unit tested.
 */

export type Op = RewritePatch["ops"][number];
export type FieldValues = Record<RewriteField, string | null>;

export interface PatchOutcome {
  /** the new full value of every field that actually changed (the others are not returned) */
  fields: Partial<Record<RewriteField, string>>;
  applied: { field: RewriteField; op: Op["op"]; reason: string | null }[];
  skipped: { field: RewriteField; op: Op["op"]; reason: string }[];
}

const LONG = new Set<RewriteField>(["catalogDescription", "bibliographicNotes", "conditionNotes"]);

/** The same cleaning every AI text gets, applied to the inserted text only. */
function cleanContent(field: RewriteField, text: string | null | undefined): string {
  let t = normalizeDashes(String(text ?? "")).replace(/\r\n?/g, "\n").replace(/\\n/g, "\n").trim();
  t = stripImageIds(t) ?? "";
  if (field !== "title" && field !== "catalogHeadline") t = stripMeasurements(t) ?? "";
  return t.trim();
}

const tidy = (s: string) => s.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

function insertAfterAnchor(cur: string, anchor: string, content: string): string | null {
  const i = cur.indexOf(anchor);
  if (i < 0) return null;
  const end = i + anchor.length;
  const rest = cur.slice(end);
  const atParagraphEnd = rest === "" || /^[ \t]*\n/.test(rest);
  return atParagraphEnd ? `${cur.slice(0, end)}\n\n${content}${rest.replace(/^[ \t]*/, "")}` : `${cur.slice(0, end)} ${content} ${rest.trimStart()}`;
}

function addToLongText(field: RewriteField, cur: string, content: string, anchor: string | null): string | null {
  if (!cur) return content;
  if (anchor) return insertAfterAnchor(cur, anchor, content);
  if (field === "catalogDescription") {
    // before the last (condition) paragraph, as a new paragraph; otherwise at the end
    const paras = cur.split(/\n{2,}/);
    if (paras.length >= 2 && /^מצב(?:[\s:]|$)/.test(paras[paras.length - 1]!.trim())) return [...paras.slice(0, -1), content, paras[paras.length - 1]!].join("\n\n");
    return `${cur}\n\n${content}`;
  }
  return `${cur} ${content}`;
}

export function applyOps(current: FieldValues, ops: Op[]): PatchOutcome {
  const work: FieldValues = { ...current };
  const out: PatchOutcome = { fields: {}, applied: [], skipped: [] };
  const skip = (o: Op, reason: string) => out.skipped.push({ field: o.field, op: o.op, reason });

  for (const o of ops) {
    if (!REWRITE_FIELDS.includes(o.field)) {
      skip(o, "שדה לא מוכר");
      continue;
    }
    const f = o.field;
    const cur = work[f] ?? "";
    const long = LONG.has(f);
    let next: string | null = null;

    if (o.op === "add") {
      const content = cleanContent(f, o.content);
      if (!content) {
        skip(o, "אין תוכן להוספה");
        continue;
      }
      if (cur.includes(content)) {
        skip(o, "הפרט כבר מופיע בשדה");
        continue;
      }
      if (long) {
        next = addToLongText(f, cur, content, o.anchor?.trim() || null);
        if (next === null) {
          skip(o, "העוגן שצוין לא נמצא בטקסט הנוכחי");
          continue;
        }
      } else next = cur ? `${cur}; ${content}` : content;
    } else if (o.op === "replace") {
      const content = cleanContent(f, o.content);
      const target = o.target ?? null;
      if (o.content === null) {
        skip(o, "חסר תוכן להחלפה");
        continue;
      }
      if (target === null || target === "") {
        if (long) {
          skip(o, "להחלפה בשדה ארוך יש לציין את הטקסט להחלפה");
          continue;
        }
        next = content;
      } else {
        if (!cur.includes(target)) {
          skip(o, "הטקסט להחלפה לא נמצא בשדה כפי שהוא עכשיו");
          continue;
        }
        next = cur.split(target).join(content);
      }
    } else {
      const target = o.target ?? "";
      if (!target) {
        skip(o, "חסר הטקסט למחיקה");
        continue;
      }
      if (!cur.includes(target)) {
        skip(o, "הטקסט למחיקה לא נמצא בשדה כפי שהוא עכשיו");
        continue;
      }
      next = cur.split(target).join("");
    }

    const result = long || f === "catalogDescription" ? tidy(next) : next.trim();
    if (result.length > AI_MAX_LENGTH[f]) {
      skip(o, "התוצאה ארוכה מהמותר בשדה");
      continue;
    }
    if (result === cur) {
      skip(o, "לא נוצר שינוי");
      continue;
    }
    work[f] = result || null;
    out.applied.push({ field: f, op: o.op, reason: o.reason?.trim() || null });
  }

  for (const f of REWRITE_FIELDS) {
    // only the edited text changes: the rest of a field is returned exactly as it was saved (no re-cleaning of it)
    if (work[f] && work[f] !== (current[f] ?? "")) out.fields[f] = work[f]!;
  }
  return out;
}
