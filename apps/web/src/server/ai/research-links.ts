import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { classifyUrl, safeExternalUrl, type Citation, type ResearchSource } from "./research-core";

/*
 * Automatic check of the research links - the part of "is this really the page" that a machine can answer safely.
 *
 * The server asks each source address ONCE (GET, small, short timeout) and records, never claiming more than it saw:
 *   access   reachable (2xx) | restricted (login / bot protection / rate limit) | not_found (404 / 410) | unchecked
 *   support  found (a readable page whose text contains the source's identifying words) | not_found (a readable page
 *            without them) | unchecked (script-rendered page, PDF, blocked, error)
 *   kind     an address that turns out - after redirects - to be a picture file is marked image_only
 * "verified" stays false: only a person verifies a source.
 *
 * Safety (the address comes from the internet): http(s) only, a public-looking host, the host's DNS answers are all
 * public addresses (no loopback / private / link-local / metadata ranges, IPv4 or IPv6), every redirect hop is validated
 * again (at most 4, manual), the body is capped and read only for HTML, no cookies / credentials are sent, and a failure
 * never fails the research. Disabled with BOOK_AI_LINK_CHECK=off (tests, offline runs).
 */

const TIMEOUT_MS = 6000;
const MAX_HOPS = 4;
const MAX_BODY = 300_000;
const CONCURRENCY = 3;

export interface LinkProbe {
  status: number;
  finalUrl: string;
  contentType: string | null;
  /** the beginning of an HTML / text answer, null otherwise */
  body: string | null;
}
type Probe = (url: string) => Promise<LinkProbe>;
let probeOverride: Probe | null = null;
/** tests: replace the network */
export function setLinkProbeOverride(p: Probe | null) {
  probeOverride = p;
}

/** a resolved address that must never be requested */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1" || x.startsWith("fe80") || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("ff")) return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }
  return true;
}

async function assertPublic(url: string) {
  const safe = safeExternalUrl(url);
  if (!safe) throw new Error("unsafe url");
  const host = new URL(safe).hostname;
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error("non-public address");
  return safe;
}

async function realProbe(start: string): Promise<LinkProbe> {
  let url = start;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    url = await assertPublic(url);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: "GET", redirect: "manual", signal: ctl.signal, headers: { accept: "text/html,application/pdf;q=0.9,*/*;q=0.5", "user-agent": "Mozilla/5.0 (compatible; AVOT-link-check)" } });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        void res.body?.cancel();
        url = new URL(res.headers.get("location")!, url).toString();
        continue;
      }
      const contentType = res.headers.get("content-type");
      let body: string | null = null;
      if (res.ok && /text\/html|text\/plain|xhtml/i.test(contentType ?? "") && res.body) {
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (size < MAX_BODY) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          chunks.push(value);
          size += value.length;
        }
        void reader.cancel().catch(() => undefined);
        body = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
      } else void res.body?.cancel();
      return { status: res.status, finalUrl: url, contentType, body };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("too many redirects");
}

const words = (s: string) => [...new Set((s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !/^(www|http|https|html|com|org|net)$/.test(w)))];
const textOf = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .toLowerCase();

/** Does a readable page contain the words that identify the item? (at least 60% of up to 8 identifying words, and at least 2) */
export function pageSupports(html: string, s: Pick<ResearchSource, "title" | "identifier">): "found" | "not_found" | "unchecked" {
  const text = textOf(html);
  // a page whose content is drawn by scripts has almost no text: nothing can be said about it
  if (text.replace(/\s+/g, " ").length < 1500) return "unchecked";
  const want = words(`${s.title} ${s.identifier ?? ""}`).slice(0, 8);
  if (want.length < 2) return "unchecked";
  const hit = want.filter((w) => text.includes(w)).length;
  return hit >= 2 && hit / want.length >= 0.6 ? "found" : "not_found";
}

async function check(s: ResearchSource): Promise<ResearchSource> {
  if (s.linkQuality === "image_only") return s;
  try {
    const probe = await (probeOverride ?? realProbe)(s.url);
    const next: ResearchSource = { ...s };
    const type = (probe.contentType ?? "").toLowerCase();
    if (/^image\//.test(type) || classifyUrl(probe.finalUrl) === "image") {
      // the address (maybe after a redirect) is a picture: not a text source
      next.linkQuality = "image_only";
      next.linkKind = "image";
      next.access = "reachable";
      return next;
    }
    if (/application\/pdf/.test(type)) next.linkKind = "pdf";
    if (probe.status === 404 || probe.status === 410) next.access = "not_found";
    else if (probe.status === 401 || probe.status === 403 || probe.status === 429 || probe.status === 451 || probe.status >= 500) next.access = "restricted";
    else if (probe.status >= 200 && probe.status < 300) {
      next.access = "reachable";
      if (probe.body && s.linkQuality === "direct") next.support = pageSupports(probe.body, s);
    }
    return next;
  } catch {
    return s;
  }
}

/**
 * Checks the sources (concurrency 3) and returns them updated. A source that was not checked keeps its fields.
 * `citations` is accepted for symmetry with vetting (a later improvement may use the titles); unused today.
 */
export async function verifyLinks(sources: ResearchSource[], _citations: Citation[] = []): Promise<ResearchSource[]> {
  if (!probeOverride && process.env.BOOK_AI_LINK_CHECK === "off") return sources;
  const out = [...sources];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= out.length) return;
      out[i] = await check(out[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, out.length) }, worker));
  return out;
}


