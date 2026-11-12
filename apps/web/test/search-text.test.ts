import { describe, expect, it } from "vitest";
import { matchesTokens, normalizeQuery, parseEnumList, parseIdList, parseList, searchTokens } from "@/lib/search-text";

describe("list search text", () => {
  it("collapses every kind of space and drops invisible marks", () => {
    expect(normalizeQuery("  נועם \u00A0  אלימלך\u200F ")).toBe("נועם אלימלך");
    expect(normalizeQuery("שָׁלוֹם")).toBe("שלום"); // Hebrew points never stop a match
    expect(normalizeQuery(null)).toBe("");
  });

  it("splits into words, no duplicates, at most 6", () => {
    expect(searchTokens("נועם אלימלך נועם")).toEqual(["נועם", "אלימלך"]);
    expect(searchTokens("a b c d e f g h")).toHaveLength(6);
    expect(searchTokens("   ")).toEqual([]);
  });

  it("every word must match, in any order, in any field", () => {
    const row = ["ספר נועם אלימלך", "ליזענסק", 1788, "ITM-0001"];
    expect(matchesTokens(row, "אלימלך נועם")).toBe(true);
    expect(matchesTokens(row, "נועם ליזענסק")).toBe(true);
    expect(matchesTokens(row, "נועם 1788")).toBe(true);
    expect(matchesTokens(row, "נועם צבי")).toBe(false);
    expect(matchesTokens(row, "")).toBe(true);
  });

  it("parses multi-value parameters and keeps only allowed values", () => {
    expect(parseList("a,b,,a")).toEqual(["a", "b"]);
    expect(parseList(["a,b", "c"])).toEqual(["a", "b", "c"]);
    expect(parseList(undefined)).toEqual([]);
    expect(parseEnumList("SOLD,BOGUS,UNSOLD", ["SOLD", "UNSOLD"] as const)).toEqual(["SOLD", "UNSOLD"]);
    expect(parseIdList("not-an-id,3f2b8c1e-0000-4000-8000-000000000001")).toEqual(["3f2b8c1e-0000-4000-8000-000000000001"]);
  });
});
