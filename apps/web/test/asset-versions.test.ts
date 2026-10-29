import { describe, expect, it } from "vitest";
import { PROCESSED_NOT_READY, downloadOptions, processedPending, processedReady } from "@/lib/asset-versions";

const asset = (state: string | null, hasFile: boolean, files: { role: string; uploadStatus: string }[] = [{ role: "PRIMARY", uploadStatus: "VERIFIED" }]) => ({
  id: "a1",
  processedUrl: hasFile ? "/api/assets/a1/processed?v=DONE17" : null,
  processed: state ? { state, hasFile, mime: "image/png" } : null,
  files,
});

describe("which picture a download button gives", () => {
  it("processed when the final file exists (DONE / NEEDS_REVIEW), carrying the version so a re-edit is never served from cache", () => {
    for (const s of ["DONE", "NEEDS_REVIEW"]) {
      const o = downloadOptions(asset(s, true));
      expect(o.primary).toEqual({ href: "/api/assets/a1/processed?download=1&v=DONE17", kind: "processed" });
      expect(o.processedMessage).toBeNull();
      expect(o.original.href).toBe("/api/assets/a1/original?download=1&v=DONE17");
    }
  });

  it("never silently falls back to the original while processing is queued, preview-only or failed", () => {
    for (const s of ["QUEUED", "PREVIEW_READY", "FAILED"]) {
      const a = asset(s, s !== "FAILED"); // a stale key can exist while a re-edit is queued
      expect(processedReady(a)).toBe(false);
      expect(processedPending(a)).toBe(true);
      const o = downloadOptions(a);
      expect(o.primary).toBeNull();
      expect(o.processed).toBeNull();
      expect(o.processedMessage).toBe(PROCESSED_NOT_READY);
      expect(o.original.href).toContain("/original?download=1"); // the original stays an explicit, separate choice
    }
  });

  it("a photo that was never processed downloads its original, labelled as such", () => {
    const o = downloadOptions(asset(null, false));
    expect(o.primary).toEqual({ href: expect.stringContaining("/original?download=1"), kind: "original" });
    expect(o.processedMessage).toBeNull();
  });

  it("RAW is its own choice, only when a verified RAW file exists", () => {
    expect(downloadOptions(asset("DONE", true)).raw).toBeNull();
    const raw = downloadOptions(asset("DONE", true, [{ role: "PRIMARY", uploadStatus: "VERIFIED" }, { role: "RAW", uploadStatus: "VERIFIED" }])).raw;
    expect(raw?.href).toContain("role=RAW");
    expect(downloadOptions(asset("DONE", true, [{ role: "RAW", uploadStatus: "PENDING" }])).raw).toBeNull();
  });
});
