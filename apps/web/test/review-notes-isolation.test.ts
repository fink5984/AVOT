import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * "הערות לבדיקה" are internal, unverified remarks: they must never be part of any AI input. The runtime specs (the
 * SENTINEL tests in the integration suite) prove it on every path; this one keeps the structure honest: no module that
 * builds or runs an AI request can even reach the notes (no import, no query of the table, no relation include).
 */

const root = path.resolve(__dirname, "../src");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const rel = (p: string) => path.relative(root, p).split(path.sep).join("/");
const read = (p: string) => readFileSync(p, "utf8");

/** every file that can put text in front of a model */
const AI_FILES = [
  ...walk(path.join(root, "server/ai")),
  ...["ai-analysis", "ai-rewrite", "lot-ai", "lot-draft-actions"].map((n) => path.join(root, `server/services/${n}.ts`)),
];
// (the AI mapper has its own "extraReviewNotes": the model's remarks to the reviewer - unrelated to this table)
const FORBIDDEN = [/review-notes/, /ItemReviewNote/, /itemReviewNote/, /reviewNotess*:/, /.reviewNotes/];

describe("review notes stay out of every AI path", () => {
  it("no AI module imports, queries or includes the notes", () => {
    const offenders = AI_FILES.filter((f) => FORBIDDEN.some((re) => re.test(read(f)))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("the notes module is imported only by screens and API routes of the notes themselves, never by another service", () => {
    const importers = walk(root)
      .filter((f) => /from ["'](@\/server\/services\/|\.\/)review-notes["']/.test(read(f)))
      .map(rel)
      .sort();
    // pages / API routes / lists that show or count notes; a service (which could feed an AI request) never imports it
    for (const f of importers.filter((x) => x.startsWith("server/services/"))) expect(["server/services/inventory.ts", "server/services/lots.ts"]).toContain(f);
    expect(importers.some((f) => f.startsWith("server/ai/"))).toBe(false);
  });

  it("the table is only read by the notes service and by the list counters", () => {
    const readers = walk(path.join(root, "server"))
      .filter((f) => /itemReviewNote|reviewNotes/.test(read(f)))
      .map(rel)
      .sort();
    for (const f of readers) expect(["server/services/review-notes.ts", "server/services/inventory.ts", "server/services/lots.ts", "server/services/deletion.ts", "server/services/item-review.ts"]).toContain(f);
  });

  it("the targeted addition sends no photos and the lot description sends no notes field: the request builders are fixed text + the book's own details", () => {
    const rewrite = read(path.join(root, "server/services/ai-rewrite.ts"));
    expect(rewrite).toMatch(/images: \[\]/);
    const lotInput = read(path.join(root, "server/services/lot-ai.ts"));
    expect(lotInput).not.toMatch(/itemReviewNote|ItemReviewNote|reviewNotes/);
  });
});
