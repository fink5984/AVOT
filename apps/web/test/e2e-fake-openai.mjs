// A scripted stand-in for the OpenAI Responses API, for end-to-end runs of the AI features without any paid call:
//   node test/e2e-fake-openai.mjs            (port FAKE_OPENAI_PORT, default 3299)
// and start the app with BOOK_AI_OPENAI_BASE_URL=http://127.0.0.1:3299/v1 OPENAI_API_KEY=fake.
// It answers the analysis, the web-search research, the writing step after the research and the targeted rewrite
// (that one after FAKE_PATCH_DELAY_MS, so a second browser can watch the job run).
import http from "node:http";

const PORT = Number(process.env.FAKE_OPENAI_PORT ?? 3299);
const PATCH_DELAY = Number(process.env.FAKE_PATCH_DELAY_MS ?? 12000);
const requests = [];

const NLI = "https://www.nli.org.il/he/books/NNL_ALEPH000000001";
const BID = "https://www.bidspirit.com/ui/lotPage/source/catalog/auction/9/lot/9";

const analysis = {
  itemType: { value: "BOOK", confidence: "high", note: null },
  identification: { summary: "ספר חובות הלבבות, זולקווא תקנ\"ט", existingTitleCheck: "more_precise_available", conflicts: [] },
  manuscriptAnalysis: { isManuscript: false, kind: null, attributionLevel: null, transcription: null, unreadable: [], writersCount: null, confidence: null, notes: null },
  fields: Object.fromEntries(
    ["title", "subtitle", "author", "printPlace", "printYear", "publisher", "edition", "extent", "bibliographicNotes", "conditionNotes"].map((k) => [
      k,
      { status: "unknown", value: null, confidence: null, source: null, imageIds: [], note: null },
    ]),
  ),
  findings: [{ kind: "signature", imageIds: [], transcription: "שייך לה\"ה יעקב", reading: "probable", attribution: null, attributionBasis: null, significance: null }],
  catalogHighlight: { status: "found", mainFeature: "הקדשה בכתב ידו של המחבר", reason: "הקדשה אישית בשער", evidence: "בשער", confidence: "high", verified: true, secondaryFeatures: [] },
  catalog: {
    headline: "הקדשה בכתב ידו של המחבר - חובות הלבבות",
    description: "עותק של ספר חובות הלבבות, ובו הקדשה בכתב ידו של המחבר.\n\nזולקווא, תקנ\"ט [1799]. מהדורה מאוחרת.\n\nמצב: כתמים.",
    boldPhrases: ["הקדשה בכתב ידו של המחבר"],
    confidence: "medium",
  },
  imagesReviewed: [],
  requiresReview: [],
  warnings: [],
};
for (const [k, v] of [["title", "ספר חובות הלבבות"], ["author", "רבינו בחיי אבן פקודה"], ["printPlace", "זולקווא"], ["printYear", "תקנ\"ט [1799]"]]) {
  analysis.fields[k] = { status: "found", value: v, confidence: "high", source: "image", imageIds: [], note: null };
}

const research = {
  sources: [
    { url: NLI, title: "חובות הלבבות - הספרייה הלאומית", siteName: "הספרייה הלאומית", kind: "national_library", refersTo: "work", learned: "רישום ביבליוגרפי של החיבור ושל מהדורותיו.", relevance: "קטלוג הספרייה הלאומית", contradicts: null, needsVerification: [] },
    { url: BID, title: "מכירה קודמת של עותק", siteName: "Bidspirit", kind: "past_auction", refersTo: "other_copy", learned: "עותק אחר של המהדורה נמכר עם חתימת בעלים.", relevance: "עותק של אותה מהדורה", contradicts: null, needsVerification: ["האם גם בעותק שלנו יש חתימת בעלים"] },
  ],
  summary: "החיבור נדפס פעמים רבות ויש מכירות קודמות של עותקים מהמהדורה.",
  contradictions: [],
  requiresVerification: ["האם זו המהדורה הראשונה"],
  inaccessible: [],
};

const written = {
  headline: "הקדשה בכתב ידו של המחבר - חובות הלבבות",
  description: "עותק של ספר חובות הלבבות, ובו הקדשה בכתב ידו של המחבר. החיבור נדפס פעמים רבות.\n\nזולקווא, תקנ\"ט [1799]. מהדורה מאוחרת.\n\nמצב: כתמים.",
  boldPhrases: ["הקדשה בכתב ידו של המחבר"],
  claims: [{ claim: "החיבור נדפס פעמים רבות", sourceIds: ["s1"], scope: "work" }],
  contradictions: [],
  requiresReview: [],
};

const usage = { input_tokens: 4000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 800, output_tokens_details: { reasoning_tokens: 100 } };
const reply = (res, output) => {
  res.writeHead(200, { "content-type": "application/json", "x-request-id": `fake-${requests.length}` });
  res.end(JSON.stringify({ id: `resp_${requests.length}`, model: "gpt-5.4-mini-fake", status: "completed", output, usage }));
};
const message = (text, annotations = []) => ({ type: "message", content: [{ type: "output_text", text: JSON.stringify(text), annotations }] });

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      if (req.method === "GET" && req.url === "/health") return res.end("ok");
      if (req.method === "GET" && req.url === "/requests") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(requests));
      }
      if (req.method === "DELETE" && req.url === "/requests") {
        requests.length = 0;
        return res.end("cleared");
      }
      const body = raw ? JSON.parse(raw) : {};
      const name = body.text?.format?.name ?? "";
      const tools = (body.tools ?? []).map((t) => t.type);
      requests.push({ name, tools, max_tool_calls: body.max_tool_calls ?? null });
      if (tools.includes("web_search")) {
        await new Promise((r) => setTimeout(r, 500));
        return reply(res, [
          { type: "web_search_call", status: "completed", action: { type: "search", query: "חובות הלבבות זולקווא תקנ\"ט", sources: [{ url: NLI }, { url: BID }] } },
          message(research, [{ type: "url_citation", url: NLI, title: "NLI" }, { type: "url_citation", url: BID, title: "Bidspirit" }]),
        ]);
      }
      if (name === "item_analysis") return reply(res, [message(analysis)]);
      if (name === "catalog_after_research") return reply(res, [message(written)]);
      if (name === "catalog_patch") {
        await new Promise((r) => setTimeout(r, PATCH_DELAY));
        return reply(res, [message({ ops: [{ field: "catalogDescription", op: "add", target: null, anchor: "מהדורה מאוחרת.", content: "בשער חתימת בעלים של רבי משה סופר.", boldPhrases: ["חתימת בעלים של רבי משה סופר"], reason: "חתימה" }] })]);
      }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `fake openai: unknown request ${name}` } }));
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`fake openai on ${PORT}`));
