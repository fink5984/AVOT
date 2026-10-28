import { describe, expect, it } from "vitest";
import { sharpnessVerdict } from "@/lib/capture/sharpness";

describe("live view sharpness verdict", () => {
  it("1:1 is reported as maximum sharpness", () => {
    expect(sharpnessVerdict({ scale: 1 }).tone).toBe("ok");
    expect(sharpnessVerdict({ scale: 0.95 }).tone).toBe("ok");
  });
  it("an enlarged picture is flagged and points at the camera's own zoom", () => {
    const v = sharpnessVerdict({ scale: 1.97 });
    expect(v.tone).toBe("warn");
    expect(v.text).toContain("1.97");
    expect(v.text).toContain("EVF");
  });
  it("a reduced picture is sharp by construction", () => {
    expect(sharpnessVerdict({ scale: 0.4 }).tone).toBe("info");
  });
});
