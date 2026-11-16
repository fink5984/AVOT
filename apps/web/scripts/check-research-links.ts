/*
 * Real-network sample of the research link check (not a test: needs the internet).
 *   npx tsx --conditions=react-server scripts/check-research-links.ts [url ...]
 * Prints, per address: what it looks like, and what the automatic check found (access, support, picture).
 */
import { classifyUrl, safeExternalUrl, vetSources } from "../src/server/ai/research-core";
import { verifyLinks } from "../src/server/ai/research-links";

const urls = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "https://www.bidspirit.com/",
      "https://www.nli.org.il/he",
      "https://he.wikipedia.org/wiki/%D7%97%D7%95%D7%91%D7%95%D7%AA_%D7%94%D7%9C%D7%91%D7%91%D7%95%D7%AA",
      "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png",
      "https://commons.wikimedia.org/wiki/File:PNG_transparency_demonstration_1.png",
      "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
      "http://github.com/",
      "https://httpbin.org/redirect-to?url=https%3A%2F%2Fhttpbin.org%2Fimage%2Fpng",
      "https://httpbin.org/status/404",
      "http://127.0.0.1:3000/",
      "http://169.254.169.254/latest/meta-data/",
    ];

async function main() {
  const answer = {
    sources: urls.map((u) => ({ url: u, title: "חובות הלבבות", siteName: null, kind: "other" as const, refersTo: "work" as const, learned: "x", relevance: "y", contradicts: null, needsVerification: [], identifier: null })),
    summary: "",
    contradictions: [],
    requiresVerification: [],
    inaccessible: [],
  };
  // every address counts as "returned by the search" here: only the check is being exercised
  const { sources } = vetSources(answer, urls.map((u) => ({ url: u, title: null })), { maxSources: 50, accessedAt: new Date().toISOString() });
  const checked = await verifyLinks(sources);
  for (const u of urls) {
    const s = checked.find((x) => x.originalUrl === u || x.url === safeExternalUrl(u));
    console.log(`${s ? "kept   " : "dropped"} ${classifyUrl(u).padEnd(6)} ${s ? `${s.linkQuality}/${s.access}/${s.support}/${s.linkKind}` : "(refused as unsafe)"}  ${u.slice(0, 110)}`);
  }
}
void main();
