import { beforeAll, describe, expect, it } from "vitest";
import { getLabelProfiles, listLabelTemplates, resetLabelTemplate, saveLabelTemplate, previewLabel } from "@/server/services/label-templates";
import { hasDb, makeOrg } from "./helpers";

describe.skipIf(!hasDb)("label typeface is one central setting", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  beforeAll(async () => {
    ctx = await makeOrg("font");
  });

  it("classic by default; choosing a typeface on one label type applies to all of them and survives a reload", async () => {
    expect((await listLabelTemplates(ctx.org.id)).map((t) => t.profile.fontStyle)).toEqual(["classic", "classic", "classic"]);

    await saveLabelTemplate(ctx.admin, "BOOK", { profile: { fontStyle: "traditional", titleSizeMm: 4.5 } });
    const after = await listLabelTemplates(ctx.org.id);
    expect(after.map((t) => t.profile.fontStyle)).toEqual(["traditional", "traditional", "traditional"]);
    // the other types keep their own measurements
    expect(after.find((t) => t.type === "LOCATION")!.profile.titleSizeMm).toBe(10);
    expect(after.find((t) => t.type === "BOOK")!.profile.titleSizeMm).toBe(4.5);

    // switching again from another type
    await saveLabelTemplate(ctx.admin, "ZONE", { profile: { fontStyle: "modern" } });
    expect((await getLabelProfiles(ctx.org.id)).BOOK?.fontStyle).toBe("modern");
    expect((await getLabelProfiles(ctx.org.id)).BOOK?.titleSizeMm).toBe(4.5);
  });

  it("the preview changes with the typeface; a reset of one type keeps the chosen typeface", async () => {
    const png = async (font: "classic" | "modern") => (await previewLabel(ctx.org.id, { type: "BOOK", stock: "57x32", dotsPerMm: 8, profile: { fontStyle: font }, sample: 0 })).png;
    expect((await png("classic")).equals(await png("modern"))).toBe(false);

    const reset = await resetLabelTemplate(ctx.admin, "BOOK");
    expect(reset.fontStyle).toBe("modern");
    expect(reset.titleSizeMm).toBe(5); // the measurements are back to the defaults
    expect((await listLabelTemplates(ctx.org.id)).find((t) => t.type === "BOOK")!.profile.fontStyle).toBe("modern");
  });
});
