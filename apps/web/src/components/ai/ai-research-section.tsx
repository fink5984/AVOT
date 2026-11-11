"use client";

import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, ExternalLink, Image as ImageIcon, Sparkles } from "lucide-react";
import { Panel } from "@/components/ui/misc";
import { cn } from "@/lib/cn";
import { fmt, t } from "@/i18n";
import type { AiState } from "@/server/services/ai-analysis";
import { SOURCE_KIND_LABEL, SOURCE_SCOPE_LABEL } from "@/server/ai/research-core";

/*
 * "מחקר וממצאי AI": under the catalog description of the book page. Two parts:
 *   א. מה זוהה בתמונות - the identification, the main feature, signatures / dedications / corrections, transcriptions,
 *      confidence, reservations, images that were not analysed. A finding that belongs to an image opens it in the gallery.
 *   ב. מקורות חיצוניים - the external research of the run: what was searched, the sources with direct links, what each
 *      contributed, how it relates to THIS book (the work, the edition, or another copy), and what needs a human check.
 * Compact by default (one summary line), expands on click. Everything shown is plain text: nothing from the web is rendered as HTML.
 */

const CONFIDENCE: Record<string, string> = { high: "ביטחון גבוה", medium: "ביטחון בינוני", low: "ביטחון נמוך" };
const FINDING: Record<string, string> = {
  signature: "חתימה",
  dedication: "הקדשה",
  stamp: "חותמת",
  handwritten_note: "רישום בכתב יד",
  ownership_mark: "סימן בעלות",
  bookplate: "תווית ספרייה (אקס ליבריס)",
  censor_mark: "סימן צנזורה",
  damage: "פגם",
  special_feature: "פרט מיוחד",
  other: "אחר",
};
const READING: Record<string, string> = { certain: "קריאה ודאית", probable: "קריאה סבירה", uncertain: "קריאה משוערת", illegible: "לא קריא" };
const RESEARCH_STATUS: Record<string, string> = { completed: "המחקר הושלם", partial: "המחקר הושלם חלקית", skipped: "המחקר החיצוני לא בוצע", failed: "המחקר החיצוני נכשל" };

/** the gallery of the page listens for this and opens the image */
export const OPEN_ASSET_EVENT = "avot:open-asset";

export function AiResearchSection({ ai }: { ai: AiState }) {
  const [open, setOpen] = useState(false);
  const latest = ai.latest;
  const result = latest?.result ?? null;
  const research = latest?.research ?? null;
  if (!latest || !result) return null;

  const findings = result.findings;
  const review = [...new Map((latest.applied?.review ?? []).map((r) => [r.reason.replace(/\s+/g, " ").trim(), r])).values()];
  // the research's own verification items are already in the review list (added when the run was written)
  const needCheck = review.length;
  const sources = research?.sources ?? [];
  const skippedImages = latest.images.filter((i) => i.status === "skipped");

  /** "img-03" or a zoom "img-03-top" → the photo it belongs to */
  const assetOf = (imageId: string) => {
    const base = imageId.replace(/-(top|bottom|left|right)$/i, "");
    return latest.images.find((i) => i.imageId === base || i.imageId === imageId)?.assetId ?? null;
  };
  const openImage = (imageId: string) => {
    const assetId = assetOf(imageId);
    if (assetId) window.dispatchEvent(new CustomEvent(OPEN_ASSET_EVENT, { detail: { assetId } }));
  };
  const imageLinks = (ids: string[]) => {
    const withAsset = [...new Set(ids.filter((id) => assetOf(id)))];
    if (!withAsset.length) return null;
    return (
      <span className="inline-flex flex-wrap gap-1.5">
        {withAsset.map((id, i) => (
          <button key={id} type="button" onClick={() => openImage(id)} className="inline-flex min-h-8 items-center gap-1 rounded border border-rule px-1.5 text-[12px] text-info hover:bg-stone-2" aria-label={`פתיחת התמונה בגלריה (${i + 1})`}>
            <ImageIcon className="size-3.5" aria-hidden />
            לתמונה
          </button>
        ))}
      </span>
    );
  };

  const summary = [
    `${findings.length} ${findings.length === 1 ? "ממצא" : "ממצאים"} בתמונות`,
    research && research.status !== "skipped" && research.status !== "failed" ? `${sources.length} ${sources.length === 1 ? "מקור חיצוני" : "מקורות חיצוניים"}` : research ? RESEARCH_STATUS[research.status] : "ללא מחקר חיצוני",
    needCheck ? `${needCheck} ${needCheck === 1 ? "פרט דורש" : "פרטים דורשים"} בדיקה` : null,
  ].filter(Boolean);

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="size-4 text-info" aria-hidden />
          מחקר וממצאי AI
        </span>
      }
      actions={
        <button type="button" className="inline-flex min-h-9 items-center gap-1 rounded px-2 text-[12.5px] font-medium text-info hover:bg-stone-2" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="research-toggle">
          {open ? "הסתר פירוט" : "הצג פירוט"}
          {open ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}
        </button>
      }
    >
      <div className="space-y-4 px-4 py-3 text-[13px] sm:px-5" data-testid="research-section">
        <button type="button" className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-start" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="font-medium text-ink" data-testid="research-summary">
            {summary.join(" · ")}
          </span>
        </button>

        {research && (research.status === "failed" || research.status === "skipped") && (
          <p className="rounded-md bg-warn-soft px-3 py-2 text-[12.5px] text-warn" data-testid="research-not-done">
            <AlertTriangle className="me-1 inline size-3.5" aria-hidden />
            המחקר החיצוני לא בוצע בניתוח הזה{research.reason ? `: ${research.reason}` : ""}. התיאור נכתב מהתמונות בלבד.
          </p>
        )}
        {!research && <p className="text-[12px] text-muted">הניתוח הזה בוצע לפני שנוסף המחקר החיצוני.</p>}

        {open && (
          <div className="space-y-5">
            {/* ───────── א. מה זוהה בתמונות ───────── */}
            <section className="space-y-2.5" aria-label="מה זוהה בתמונות">
              <h3 className="text-[12px] font-semibold text-muted">מה זוהה בתמונות</h3>
              {result.identification.summary && <p className="text-ink-2">{result.identification.summary}</p>}
              {result.catalogHighlight?.status === "found" && result.catalogHighlight.mainFeature && (
                <div className="rounded-md border border-info/30 bg-info-soft px-3 py-2">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <Sparkles className="size-3.5 self-center text-info" aria-hidden />
                    <span className="text-[12px] text-muted">המאפיין המרכזי:</span>
                    <span className="font-medium text-ink">{result.catalogHighlight.mainFeature}</span>
                    <span className={cn("text-[12px]", result.catalogHighlight.verified ? "text-muted" : "text-warn")}>
                      {result.catalogHighlight.verified ? "מאומת" : "לא מאומת"}
                      {result.catalogHighlight.confidence ? ` · ${CONFIDENCE[result.catalogHighlight.confidence]}` : ""}
                    </span>
                  </div>
                  {result.catalogHighlight.reason && <div className="text-[12.5px] text-ink-2">{result.catalogHighlight.reason}</div>}
                </div>
              )}
              <p className="text-[12px] text-muted">
                רמת ודאות בתיאור הקטלוגי: <span className="font-medium text-ink-2">{CONFIDENCE[result.catalog.confidence] ?? result.catalog.confidence}</span>
                {result.itemType.confidence !== "high" && <> · סוג הפריט: {CONFIDENCE[result.itemType.confidence]}</>}
              </p>
              {findings.length > 0 ? (
                <ul className="space-y-1.5">
                  {findings.map((f, i) => (
                    <li key={i} className="rounded-md bg-stone-2 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium text-ink">{FINDING[f.kind] ?? f.kind}</span>
                        <span className={cn("text-[12px]", f.reading === "certain" ? "text-muted" : "text-warn")}>{READING[f.reading]}</span>
                        {imageLinks(f.imageIds)}
                      </div>
                      {f.transcription && <div className="mt-0.5 whitespace-pre-line text-ink">&quot;{f.transcription}&quot;</div>}
                      {f.attribution && (
                        <div className="mt-0.5 text-[12px] text-ink-2">
                          ייחוס: {f.attribution}
                          {f.attributionBasis && <> - {f.attributionBasis}</>}
                        </div>
                      )}
                      {f.significance && <div className="text-[12px] text-ink-2">{f.significance}</div>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] text-muted">לא זוהו חתימות, הקדשות, הגהות או ממצאים מיוחדים בתמונות.</p>
              )}
              {result.manuscriptAnalysis?.isManuscript && (
                <div className="space-y-1.5 rounded-md bg-stone-2 px-3 py-2">
                  <div className="font-medium text-ink">כתב יד{result.manuscriptAnalysis.confidence ? ` · ${CONFIDENCE[result.manuscriptAnalysis.confidence]}` : ""}</div>
                  {result.manuscriptAnalysis.transcription && (
                    <details>
                      <summary className="cursor-pointer text-[12.5px] font-medium text-info">תמלול</summary>
                      <p className="mt-1 whitespace-pre-line text-ink">{result.manuscriptAnalysis.transcription}</p>
                    </details>
                  )}
                  {result.manuscriptAnalysis.unreadable.length > 0 && <p className="text-[12.5px] text-warn">חלקים שלא נקראו היטב: {result.manuscriptAnalysis.unreadable.join("; ")}</p>}
                </div>
              )}
              {review.length > 0 && (
                <div className="rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[12.5px]">
                  <div className="font-medium text-ink">הסתייגויות ופרטים לבדיקה ({review.length})</div>
                  <ul className="mt-1 list-disc space-y-0.5 ps-5 text-ink-2">
                    {review.map((r, i) => (
                      <li key={i}>{r.reason}</li>
                    ))}
                  </ul>
                </div>
              )}
              {skippedImages.length > 0 && (
                <p className="text-[12px] text-warn">
                  תמונות שלא נותחו: {skippedImages.map((i) => `${t.categoryShort[i.category as keyof typeof t.categoryShort] ?? i.category} (${i.reason})`).join(" · ")}
                </p>
              )}
            </section>

            {/* ───────── ב. מקורות חיצוניים ───────── */}
            <section className="space-y-2.5 border-t border-rule pt-4" aria-label="מקורות חיצוניים">
              <h3 className="text-[12px] font-semibold text-muted">מקורות חיצוניים</h3>
              {!research ? (
                <p className="text-[12px] text-muted">אין נתוני מחקר חיצוני לניתוח הזה.</p>
              ) : (
                <>
                  <p className="text-[12px] text-muted">
                    {RESEARCH_STATUS[research.status]}
                    {research.searches > 0 && <> · {research.searches} חיפושים</>}
                    {research.model && <> · <span dir="ltr">{research.provider} · {research.model}</span></>}
                    {research.costUsd !== null && <> · עלות משוערת ${research.costUsd.toFixed(4)}</>}
                    {research.sources.length > 0 && <> · נגישות למקורות: {fmt.dateTime(new Date(research.accessedAt))}</>}
                  </p>
                  {research.summary && sources.length > 0 && <p className="text-ink-2">{research.summary}</p>}
                  {research.status === "partial" && research.reason && <p className="text-[12.5px] text-warn">{research.reason}</p>}
                  {sources.length > 0 && (
                    <ul className="space-y-2" data-testid="research-sources">
                      {sources.map((s) => {
                        const cites = research.claims.filter((c) => c.sourceIds.includes(s.id));
                        return (
                          <li key={s.id} className="rounded-md border border-rule px-3 py-2">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-8 max-w-full items-center gap-1 break-all font-medium text-info underline" dir="auto">
                                {s.title}
                                <ExternalLink className="size-3.5 shrink-0" aria-hidden />
                              </a>
                              <span className="text-[12px] text-muted">{s.siteName ?? s.host}</span>
                              <span className="rounded bg-stone-2 px-1.5 text-[11.5px] text-ink-2">{SOURCE_KIND_LABEL[s.kind]}</span>
                              <span className={cn("rounded px-1.5 text-[11.5px]", s.refersTo === "other_copy" ? "bg-warn-soft text-warn" : "bg-stone-2 text-ink-2")}>{SOURCE_SCOPE_LABEL[s.refersTo]}</span>
                            </div>
                            <p className="mt-1 text-ink-2">{s.learned}</p>
                            {s.relevance && <p className="text-[12px] text-muted">למה מתאים: {s.relevance}</p>}
                            {s.contradicts && (
                              <p className="mt-1 rounded bg-warn-soft px-2 py-1 text-[12.5px] text-warn">
                                <AlertTriangle className="me-1 inline size-3.5" aria-hidden />
                                סותר את מה שזוהה בתמונות: {s.contradicts}
                              </p>
                            )}
                            {s.needsVerification.length > 0 && <p className="mt-1 text-[12.5px] text-warn">לאימות אנושי: {s.needsVerification.join("; ")}</p>}
                            {cites.length > 0 && (
                              <p className="mt-1 text-[12px] text-ink-2">
                                נשען עליו בתיאור: {cites.map((c) => c.claim).join("; ")}
                              </p>
                            )}
                            <p className="mt-1 text-[11.5px] text-muted">
                              לא אומת בידי אדם · {s.urlCheck === "cited" ? "הכתובת הוחזרה מכלי החיפוש" : "אותר דרך האתר שדווח בחיפוש, הכתובת המדויקת לא אומתה"} · {fmt.dateTime(new Date(s.accessedAt))}
                            </p>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {research.contradictions.length > 0 && (
                    <div className="rounded-md bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
                      <div className="font-medium">סתירות בין המקורות לתמונות (הזיהוי מהתמונות לא הוחלף)</div>
                      <ul className="list-disc ps-5">
                        {research.contradictions.map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {research.requiresVerification.length > 0 && (
                    <div className="rounded-md bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
                      <div className="font-medium">פרטים שמחייבים אימות אנושי</div>
                      <ul className="list-disc ps-5">
                        {research.requiresVerification.map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {research.inaccessible.length > 0 && <p className="text-[12px] text-muted">מקורות שלא היו נגישים: {research.inaccessible.join("; ")}</p>}
                  {research.droppedUnverified > 0 && <p className="text-[12px] text-muted">{research.droppedUnverified} כתובות שהמודל ציין לא הוצגו כי כלי החיפוש לא החזיר אותן.</p>}
                  {research.searched.length > 0 && (
                    <details className="text-[12px] text-muted">
                      <summary className="cursor-pointer font-medium">שאילתות החיפוש ({research.searched.length})</summary>
                      <ul className="mt-1 list-disc ps-5" dir="auto">
                        {research.searched.map((q, i) => (
                          <li key={i}>{q}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </Panel>
  );
}
