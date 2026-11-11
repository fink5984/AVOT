import { describe, expect, it } from "vitest";
import { addBoldPhrases, applyStyle, boldSegments, carryFormat, plainText, type Segment } from "@/lib/rich-text";

const TEXT = 'עותק של ספר חידושי תורה, ובו הקדשה בכתב ידו של המחבר.\n\nפרטי הדפוס: פראג תקפ"ה (1825). מצב: כתמים.';

describe("automatic bold from phrases", () => {
  it("bolds exactly the requested phrase and keeps the text identical", () => {
    const r = boldSegments(TEXT, ["הקדשה בכתב ידו של המחבר"]);
    expect(r.segments).not.toBeNull();
    expect(plainText(r.segments!)).toBe(TEXT);
    expect(r.segments!.filter((s) => s.b).map((s) => s.t)).toEqual(["הקדשה בכתב ידו של המחבר"]);
    expect(r.skipped).toEqual([]);
  });

  it("matches typographic quotes and dashes without changing the text", () => {
    const r = boldSegments(TEXT, ["תקפ״ה"]);
    expect(r.segments!.find((s) => s.b)?.t).toBe('תקפ"ה');
    expect(plainText(r.segments!)).toBe(TEXT);
  });

  it("skips a phrase that is not in the text, a partial word and a duplicate", () => {
    const r = boldSegments(TEXT, ["משפט שלא קיים בטקסט", "חידוש", "תורה", "תורה"]);
    expect(r.skipped.map((s) => s.reason)).toEqual(["הביטוי לא נמצא בטקסט במדויק", "הביטוי לא נמצא בטקסט במדויק"]);
    expect(r.segments!.filter((s) => s.b).map((s) => s.t)).toEqual(["תורה"]);
  });

  it("never bolds a whole long paragraph", () => {
    const para = "זהו תיאור ארוך של הספר ".repeat(8).trim() + ".";
    const text = `${para}

פסקה שנייה קצרה יותר, עם עוד כמה מילים כדי להשלים את האורך הדרוש לבדיקה.

פסקה שלישית.`;
    const r = boldSegments(text, [para]);
    expect(r.segments).toBeNull();
    expect(r.skipped[0]?.reason).toBe("פסקה שלמה");
  });

  it("keeps a Hebrew point with its letter", () => {
    const t = "כתב יד של רבי משֶׁה סופר ועוד טקסט ארוך כדי שההדגשה תהיה קטנה יחסית לכל התיאור הזה כאן.";
    const r = boldSegments(t, ["משֶׁה"]);
    expect(r.segments!.find((s) => s.b)?.t).toBe("משֶׁה");
    expect(plainText(r.segments!)).toBe(t);
  });

  it("limits the number and the share of bold text", () => {
    const words = Array.from({ length: 12 }, (_, i) => `מילה${"אבגדהוזחטיכל"[i]}${"אבגדהוזחטיכל"[i]}`);
    const text = words.join(" ") + " " + "ט".repeat(400);
    const r = boldSegments(text, words);
    expect(r.applied.length).toBeLessThanOrEqual(8);
    const bold = (r.segments ?? []).filter((s) => s.b).reduce((n, s) => n + s.t.length, 0);
    expect(bold).toBeLessThanOrEqual(0.4 * text.length);
  });

  it("returns no formatting for empty input", () => {
    expect(boldSegments("", ["xyz"]).segments).toBeNull();
    expect(boldSegments(TEXT, []).segments).toBeNull();
  });
});

describe("carrying formatting across an edit", () => {
  const old = "ספר ישן עם הקדשה חשובה בשער. מצב: כתמים.";
  const from = old.indexOf("הקדשה חשובה");
  const bold: Segment[] = applyStyle([{ t: old }], from, from + "הקדשה חשובה".length, { b: true });

  it("keeps bold on untouched text when a sentence is added elsewhere", () => {
    const next = "ספר ישן עם הקדשה חשובה בשער. החתימה בשער היא של רבי משה. מצב: כתמים.";
    const segs = carryFormat(old, bold, next);
    expect(plainText(segs)).toBe(next);
    expect(segs.filter((s) => s.b).map((s) => s.t)).toEqual(["הקדשה חשובה"]);
  });

  it("drops bold only on the replaced words", () => {
    const next = "ספר ישן עם הקדשה אישית בשער. מצב: כתמים.";
    const segs = carryFormat(old, bold, next);
    expect(plainText(segs)).toBe(next);
    expect(segs.filter((s) => s.b).map((s) => s.t.trim())).toEqual(["הקדשה"]);
  });

  it("keeps manual underline and color too, and never changes the new text", () => {
    const colored = applyStyle(bold, 0, 3, { u: true, c: "#b42318" });
    const segs = carryFormat(old, colored, old + " תוספת.");
    expect(plainText(segs)).toBe(old + " תוספת.");
    expect(segs[0]).toMatchObject({ u: true, c: "#b42318" });
  });

  it("returns plain text when the old formatting did not describe the old text", () => {
    expect(carryFormat("אחר", bold, "טקסט חדש")).toEqual([{ t: "טקסט חדש" }]);
    expect(carryFormat(old, undefined, "x")).toEqual([{ t: "x" }]);
  });

  it("adds bold only inside an inserted region", () => {
    const text = "פתיחה. חתימה חשובה כאן. סוף. חתימה חשובה שוב.";
    const at = text.lastIndexOf("חתימה חשובה");
    const out = addBoldPhrases(text, [{ t: text }], ["חתימה חשובה"], [at, text.length]);
    expect(plainText(out)).toBe(text);
    expect(out.filter((s) => s.b).map((s) => s.t)).toEqual(["חתימה חשובה"]);
    expect(out[0]!.t.startsWith("פתיחה. חתימה חשובה כאן")).toBe(true);
  });
});
