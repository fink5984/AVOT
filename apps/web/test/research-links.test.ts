import { afterEach, describe, expect, it } from "vitest";
import { betterPageFor, classifyUrl, safeExternalUrl, vetSources, type ResearchAnswer } from "@/server/ai/research-core";
import { isPrivateAddress, pageSupports, setLinkProbeOverride, verifyLinks } from "@/server/ai/research-links";

const answer = (sources: Partial<ResearchAnswer["sources"][number]>[]): ResearchAnswer => ({
  sources: sources.map((s) => ({ url: "https://a.example.com/x", title: "כותרת", siteName: null, kind: "other", refersTo: "work", learned: "נלמד", relevance: "מתאים", contradicts: null, needsVerification: [], identifier: null, ...s })),
  summary: "",
  contradictions: [],
  requiresVerification: [],
  inaccessible: [],
});
const at = "2026-11-16T00:00:00.000Z";

describe("what an address points to", () => {
  it("pictures, image CDNs, the home page and listings are told apart from real pages (and PDFs stay allowed)", () => {
    for (const u of [
      "https://cdn.bidspirit.com/images/lots/72.jpg",
      "https://res.cloudinary.com/x/image/upload/v1/abc.webp",
      "https://example.com/photo?id=3&format=jpg",
      "https://example.com/thumbnails/72/small",
      "https://images.example.com/a/0123456789abcdef0123/x.png",
    ]) expect(classifyUrl(u), u).toBe("image");
    for (const u of ["https://www.bidspirit.com/", "https://www.nli.org.il/he", "https://example.com/index.html"]) expect(classifyUrl(u), u).toBe("home");
    for (const u of ["https://example.com/search?q=חובות", "https://example.com/results", "https://example.com/?s=book"]) expect(classifyUrl(u), u).toBe("search");
    expect(classifyUrl("https://example.com/books/Hovot-HaLevavot.pdf")).toBe("pdf");
    for (const u of ["https://www.nli.org.il/he/books/NNL_ALEPH990001/NLI", "https://il.bidspirit.com/ui/lotPage/source/catalog/auction/1/lot/72", "https://example.com/lot/72"]) expect(classifyUrl(u), u).toBe("page");
  });

  it("an address is kept exactly: a PDF page and a single-page-app route survive, tracking does not", () => {
    expect(safeExternalUrl("https://example.com/a.pdf#page=12")).toBe("https://example.com/a.pdf#page=12");
    expect(safeExternalUrl("https://app.example.com/ui/?utm_source=x#/lot/72")).toBe("https://app.example.com/ui/#/lot/72");
    expect(safeExternalUrl("https://example.com/x?ref=5&utm_medium=m#top")).toBe("https://example.com/x?ref=5");
  });
});

describe("the page instead of the picture", () => {
  const citations = [
    { url: "https://il.bidspirit.com/img/lots/72.jpg", title: "Hovot HaLevavot" },
    { url: "https://il.bidspirit.com/ui/lotPage/auction/18/lot/72", title: "חובות הלבבות זולקווא תקנ\"ט - מכירה 18 לוט 72" },
    { url: "https://il.bidspirit.com/ui/lotPage/auction/18/lot/11", title: "סידור תפילה - מכירה 18 לוט 11" },
    { url: "https://other.example.org/x", title: "חובות הלבבות" },
  ];
  it("a returned picture is replaced by the page of the same site that the search itself returned, never by a constructed address", () => {
    const { sources } = vetSources(answer([{ url: "https://il.bidspirit.com/img/lots/72.jpg", title: "חובות הלבבות זולקווא", learned: "עותק של חובות הלבבות נמכר, לוט 72", identifier: "מכירה 18, לוט 72" }]), citations, { maxSources: 5, accessedAt: at });
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ url: "https://il.bidspirit.com/ui/lotPage/auction/18/lot/72", originalUrl: "https://il.bidspirit.com/img/lots/72.jpg", linkQuality: "direct", urlCheck: "cited", identifier: "מכירה 18, לוט 72" });
  });
  it("with no page to prefer, a picture stays marked image_only (no link is offered) and a home page is marked generic; an invented address is dropped", () => {
    const onlyImage = [{ url: "https://il.bidspirit.com/img/lots/99.jpg", title: "x" }, { url: "https://il.bidspirit.com/", title: "Bidspirit" }];
    const r = vetSources(answer([{ url: "https://il.bidspirit.com/img/lots/99.jpg", title: "עותק אחר" }, { url: "https://il.bidspirit.com/", title: "Bidspirit" }, { url: "https://il.bidspirit.com/ui/lotPage/auction/18/lot/5000", title: "בדוי" }]), onlyImage, { maxSources: 5, accessedAt: at });
    expect(r.sources.map((s) => [s.url, s.linkQuality])).toEqual([["https://il.bidspirit.com/img/lots/99.jpg", "image_only"], ["https://il.bidspirit.com/", "generic"]]);
    expect(r.dropped).toBe(1);
  });
  it("betterPageFor needs real overlap with the item; unrelated pages of the site are not chosen", () => {
    expect(betterPageFor({ title: "ספר שונה לגמרי", learned: "", identifier: null }, "https://il.bidspirit.com/img/a.jpg", citations)).toBeNull();
  });
});

describe("the automatic link check", () => {
  afterEach(() => setLinkProbeOverride(null));
  const src = (over: Partial<Parameters<typeof vetSources>[0]["sources"][number]> = {}) =>
    vetSources(answer([{ url: "https://il.bidspirit.com/ui/lotPage/auction/18/lot/72", title: "חובות הלבבות זולקווא", identifier: "מכירה 18 לוט 72", ...over }]), [{ url: "https://il.bidspirit.com/ui/lotPage/auction/18/lot/72", title: "t" }, { url: "https://example.com/a.pdf", title: "p" }], { maxSources: 5, accessedAt: at }).sources;
  const longPage = (text: string) => `<html><body>${`<p>${text}</p>`.repeat(5)}${"<p>טקסט מילוי של האתר. ".repeat(120)}</p></body></html>`;

  it("a page that opens and mentions the item is reachable + supported; one that does not mention it is flagged; a script-only page is left unchecked", async () => {
    setLinkProbeOverride(async (url) => ({ status: 200, finalUrl: url, contentType: "text/html", body: longPage("חובות הלבבות זולקווא מכירה 18 לוט 72") }));
    expect((await verifyLinks(src()))[0]).toMatchObject({ access: "reachable", support: "found", verified: false });
    setLinkProbeOverride(async (url) => ({ status: 200, finalUrl: url, contentType: "text/html", body: longPage("דף על נושא אחר לגמרי בלי פרטים") }));
    expect((await verifyLinks(src()))[0]).toMatchObject({ access: "reachable", support: "not_found" });
    setLinkProbeOverride(async (url) => ({ status: 200, finalUrl: url, contentType: "text/html", body: "<html><div id=app></div><script>render()</script></html>" }));
    expect((await verifyLinks(src()))[0]).toMatchObject({ access: "reachable", support: "unchecked" });
  });
  it("a redirect that ends on a picture turns the source into image_only; 404 and a bot wall are told apart; a failure changes nothing", async () => {
    setLinkProbeOverride(async () => ({ status: 200, finalUrl: "https://cdn.example.com/a/b.jpg", contentType: "image/jpeg", body: null }));
    expect((await verifyLinks(src()))[0]).toMatchObject({ linkQuality: "image_only", linkKind: "image" });
    setLinkProbeOverride(async (url) => ({ status: 404, finalUrl: url, contentType: "text/html", body: null }));
    expect((await verifyLinks(src()))[0]).toMatchObject({ access: "not_found", linkQuality: "direct" });
    setLinkProbeOverride(async (url) => ({ status: 403, finalUrl: url, contentType: "text/html", body: null }));
    expect((await verifyLinks(src()))[0]).toMatchObject({ access: "restricted", support: "unchecked" });
    setLinkProbeOverride(async () => {
      throw new Error("network");
    });
    expect((await verifyLinks(src()))[0]).toMatchObject({ access: "unchecked", support: "unchecked", linkQuality: "direct" });
    setLinkProbeOverride(async (url) => ({ status: 200, finalUrl: url, contentType: "application/pdf", body: null }));
    expect((await verifyLinks(src({ url: "https://example.com/a.pdf" })))[0]).toMatchObject({ linkKind: "pdf" });
  });
  it("pageSupports needs most identifying words", () => {
    expect(pageSupports(`<p>${"חובות הלבבות ".repeat(200)}</p>`, { title: "חובות הלבבות", identifier: null })).toBe("found");
  });
  it("private and local addresses are never requested", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});
