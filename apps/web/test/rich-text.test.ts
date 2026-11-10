import { describe, expect, it } from "vitest";
import { sameSegments, serializeItemFormat, applyStyle, formatToStore, hasFormatting, plainText, rangeHas, readTextFormat, replaceRange, segmentsFor, trimSegments, wordAt, type Segment } from "@/lib/rich-text";

const plain = (t: string): Segment[] => [{ t }];

describe("rich text segments", () => {
  it("applies bold to a part of a word and merges it back when removed", () => {
    const s = applyStyle(plain("ספר ישן"), 1, 3, { b: true });
    expect(s).toEqual([{ t: "ס" }, { t: "פר", b: true }, { t: " ישן" }]);
    expect(plainText(s)).toBe("ספר ישן");
    expect(applyStyle(s, 0, 7, { b: false })).toEqual(plain("ספר ישן"));
  });

  it("combines bold, underline and color on overlapping ranges", () => {
    let s = applyStyle(plain("abcdef"), 0, 4, { b: true });
    s = applyStyle(s, 2, 6, { u: true, c: "#B42318" });
    expect(s).toEqual([{ t: "ab", b: true }, { t: "cd", b: true, u: true, c: "#b42318" }, { t: "ef", u: true, c: "#b42318" }]);
    expect(rangeHas(s, 0, 4, "b")).toBe(true);
    expect(rangeHas(s, 0, 5, "b")).toBe(false);
    expect(applyStyle(s, 0, 6, { c: null }).some((x) => x.c)).toBe(false);
  });

  it("typing takes the style of the character before it", () => {
    const s = applyStyle(plain("abc"), 0, 2, { b: true });
    expect(replaceRange(s, 2, 2, "X")).toEqual([{ t: "abX", b: true }, { t: "c" }]);
    expect(replaceRange(s, 0, 0, "X")).toEqual([{ t: "Xab", b: true }, { t: "c" }]);
    expect(replaceRange(s, 1, 3, "")).toEqual([{ t: "a", b: true }]);
    expect(replaceRange([], 0, 0, "new")).toEqual(plain("new"));
  });

  it("shows formatting only while it spells exactly the stored text", () => {
    const f = applyStyle(plain("hello world"), 0, 5, { u: true });
    expect(segmentsFor("hello world", f)).toEqual(f);
    expect(segmentsFor("hello there", f)).toEqual(plain("hello there"));
    expect(segmentsFor(null, f)).toEqual([]);
  });

  it("trims like the server and refuses formatting that does not match the stored text", () => {
    const f = applyStyle(plain("  hello \n"), 2, 7, { b: true });
    expect(trimSegments(f)).toEqual([{ t: "hello", b: true }]);
    expect(formatToStore(f, "hello")).toEqual([{ t: "hello", b: true }]);
    expect(formatToStore(f, "other")).toBeUndefined();
    expect(formatToStore(plain("hello"), "hello")).toBeUndefined();
  });

  it("reads the stored column defensively", () => {
    expect(readTextFormat(null)).toEqual({});
    expect(readTextFormat({ description: [{ t: "x", c: "red; background:url(x)" }] })).toEqual({});
    expect(readTextFormat({ description: [{ t: "x", b: true }], shortDescription: [{ t: "y" }] })).toEqual({ description: [{ t: "x", b: true }] });
    expect(hasFormatting([{ t: "", b: true }])).toBe(false);
  });

  it("finds the word around a caret", () => {
    expect(wordAt("one two three", 5)).toEqual([4, 7]);
    expect(wordAt("one two", 3)).toEqual([0, 3]);
    expect(wordAt("a  b", 2)).toEqual([2, 2]);
  });

  it("compares segment lists by content and serializes a book's formatting", () => {
    expect(sameSegments([{ t: "a" }, { t: "b" }], [{ t: "ab" }])).toBe(true);
    expect(sameSegments([{ t: "ab", b: true }], [{ t: "ab" }])).toBe(false);
    expect(serializeItemFormat(null)).toBeNull();
    expect(serializeItemFormat({ catalogDescription: [{ t: "x", u: true }], conditionNotes: [{ t: "y", b: true }] })).toBe('{"catalogDescription":[{"t":"x","u":true}]}');
  });
});
