"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ClipboardCheck, History, RotateCcw, Sparkles } from "lucide-react";
import { ITEM_TYPES, type ItemReviewStatus, type ItemType } from "@avot/shared";
import { Button } from "@/components/ui/button";
import { ReviewStatusBadge } from "@/components/ui/badge";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Panel } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { fmt, t } from "@/i18n";
import { ApiError, api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { AiState } from "@/server/services/ai-analysis";

/*
 * "פרטי הפריט ובדיקה" on the book page: the AI-writable details, editable with autosave, next to the AI's evidence.
 *
 *  - Autosave ~1.5 s after the last change, on blur, when leaving the page and when the tab is hidden. Each save
 *    carries the detailsVersion it was based on; the server refuses (409) when the details changed meanwhile (an AI
 *    result, another user), so nothing newer is overwritten silently. The unsaved edits stay on screen and in a local
 *    draft; the reviewer chooses to apply them over the new version or to discard them.
 *  - The draft is kept per item in localStorage: leaving and coming back (or a closed tab) loses nothing.
 *  - "סיימתי לבדוק - אשר פרטים" is the only way to APPROVED, and only with everything saved.
 */

export const REVIEW_FIELDS = ["itemType", "title", "subtitle", "author", "printPlace", "printYear", "publisher", "edition", "extent", "bibliographicNotes", "conditionNotes", "catalogHeadline", "catalogDescription"] as const;
export type ReviewField = (typeof REVIEW_FIELDS)[number];
export type ReviewValues = { [K in ReviewField]: K extends "itemType" ? ItemType : K extends "title" ? string : string | null };

const LABEL: Record<ReviewField, string> = {
  itemType: "סוג הפריט",
  title: "שם הפריט",
  subtitle: "כותרת משנה",
  author: "מחבר / יוצר",
  printPlace: "מקום דפוס / יצירה",
  printYear: "שנת דפוס / יצירה",
  publisher: "מדפיס / הוצאה",
  edition: "מהדורה",
  extent: "היקף / דפים",
  bibliographicNotes: "פרטים ביבליוגרפיים",
  conditionNotes: "מצב העותק",
  catalogHeadline: "כותרת קטלוגית",
  catalogDescription: "תיאור קטלוגי (טיוטה)",
};
const MAX: Record<ReviewField, number> = {
  itemType: 20,
  title: 300,
  subtitle: 300,
  author: 200,
  printPlace: 200,
  printYear: 50,
  publisher: 200,
  edition: 200,
  extent: 200,
  bibliographicNotes: 5000,
  conditionNotes: 2000,
  catalogHeadline: 500,
  catalogDescription: 20000,
};
const CONFIDENCE: Record<string, string> = { high: "ביטחון גבוה", medium: "ביטחון בינוני", low: "ביטחון נמוך" };
const SOURCE: Record<string, string> = { image: "מהתמונות", photographer_notes: "מהערות המצלם", existing_data: "מהנתונים הקיימים", inference: "הסקה", general_knowledge: "ידע כללי (לא מאומת)" };
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

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "conflict" | "error" | "offline";
const STATUS_TEXT: Record<SaveStatus, string> = {
  idle: "",
  dirty: "ממתין לשמירה…",
  saving: "שומר…",
  saved: "נשמר",
  conflict: "לא נשמר - הפרטים עודכנו בינתיים",
  error: "השמירה נכשלה",
  offline: "לא נשמר - ממתין לחיבור",
};
const DEBOUNCE_MS = 1500;
/** review remarks shown before "הצג עוד" */
const REVIEW_PREVIEW = 4;

/** a titled group of fields; the groups follow the order a cataloguer checks a book */
function FieldGroup({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <fieldset className="border-t border-rule pt-4 first-of-type:border-t-0 first-of-type:pt-0">
      <legend className="float-start mb-3 w-full text-[12px] font-semibold text-muted">{title}</legend>
      <div className="clear-both grid grid-cols-1 gap-x-3 gap-y-3.5 sm:grid-cols-6">{children}</div>
      {note && <p className="mt-2 text-[12px] text-muted">{note}</p>}
    </fieldset>
  );
}
const draftKey = (id: string) => `avot.itemDetailsDraft.${id}`;

interface Draft {
  baseVersion: number;
  fields: Partial<ReviewValues>;
}
function readDraft(id: string): Draft | null {
  try {
    const d = JSON.parse(localStorage.getItem(draftKey(id)) ?? "null") as Draft | null;
    return d && typeof d.baseVersion === "number" && d.fields && typeof d.fields === "object" ? d : null;
  } catch {
    return null;
  }
}
function writeDraft(id: string, d: Draft | null) {
  try {
    if (d && Object.keys(d.fields).length) localStorage.setItem(draftKey(id), JSON.stringify(d));
    else localStorage.removeItem(draftKey(id));
  } catch {
    /* storage blocked: autosave still works while online */
  }
}
const same = (a: unknown, b: unknown) => (a ?? "") === (b ?? "");

export function ItemReviewPanel({
  itemId,
  values: serverValues,
  detailsVersion: serverVersion,
  ai,
  canEdit,
  canReview,
  canRestore,
}: {
  itemId: string;
  values: ReviewValues;
  detailsVersion: number;
  ai: AiState;
  canEdit: boolean;
  canReview: boolean;
  canRestore: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [values, setValues] = useState<ReviewValues>(serverValues);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [reviewStatus, setReviewStatus] = useState<ItemReviewStatus>(ai.reviewStatus);
  const [busy, setBusy] = useState<string | null>(null);
  const [showRuns, setShowRuns] = useState(false);
  const [showAllReview, setShowAllReview] = useState(false);

  const base = useRef(serverValues); // values of the version the edits are based on
  const version = useRef(serverVersion);
  const dirty = useRef<Partial<ReviewValues>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(false);
  const alive = useRef(true);
  /** a 409 happened: nothing is saved automatically until the reviewer chooses */
  const conflict = useRef(false);
  const setConflict = (text: string) => {
    conflict.current = true;
    setStatus("conflict");
    setMessage(text);
  };

  useEffect(() => setReviewStatus(ai.reviewStatus), [ai.reviewStatus]);

  // new server data (AI result, router.refresh after another save): adopt it unless local edits are pending
  useEffect(() => {
    if (serverVersion === version.current && !Object.keys(dirty.current).length) {
      base.current = serverValues;
      setValues(serverValues);
      return;
    }
    if (serverVersion !== version.current) {
      if (Object.keys(dirty.current).length) {
        setConflict("פרטי הפריט עודכנו בינתיים (ניתוח AI או משתמש אחר). השינויים שלך עדיין מוצגים ולא נשמרו.");
      } else {
        base.current = serverValues;
        version.current = serverVersion;
        setValues(serverValues);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverVersion, JSON.stringify(serverValues)]);

  // a draft left from an earlier visit / closed tab comes back
  useEffect(() => {
    const d = readDraft(itemId);
    if (!d || !canEdit) return;
    const pending = Object.fromEntries(Object.entries(d.fields).filter(([k, v]) => !same(v, serverValues[k as ReviewField]))) as Partial<ReviewValues>;
    if (!Object.keys(pending).length) {
      writeDraft(itemId, null);
      return;
    }
    dirty.current = pending;
    setValues((v) => ({ ...v, ...pending }));
    if (d.baseVersion === serverVersion) {
      setStatus("dirty");
      timer.current = setTimeout(() => void flush(), 300);
    } else {
      setConflict("נמצאו שינויים שלא נשמרו מביקור קודם, אבל הפרטים עודכנו מאז. בחרו אם להחיל אותם על הגרסה החדשה.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  const flush = useCallback(
    async (opts: { keepalive?: boolean } = {}) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const fields = { ...dirty.current };
      if (inflight.current || conflict.current || !Object.keys(fields).length) return;
      if ("title" in fields && !String(fields.title ?? "").trim()) {
        setStatus("error");
        setMessage("שם הפריט אינו יכול להיות ריק");
        return;
      }
      inflight.current = true;
      if (alive.current) setStatus("saving");
      try {
        const body = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === "string" ? (v.trim() ? v : null) : v]));
        const r = await api<{ detailsVersion: number; reviewStatus: ItemReviewStatus }>(`/api/inventory/${itemId}`, { method: "PATCH", json: { ...body, expectedVersion: version.current }, keepalive: opts.keepalive });
        version.current = r.detailsVersion;
        base.current = { ...base.current, ...fields };
        // edits typed while the request was out stay dirty
        for (const [k, v] of Object.entries(fields)) if (same(dirty.current[k as ReviewField], v)) delete dirty.current[k as ReviewField];
        writeDraft(itemId, Object.keys(dirty.current).length ? { baseVersion: version.current, fields: dirty.current } : null);
        if (alive.current) {
          setReviewStatus(r.reviewStatus);
          setStatus(Object.keys(dirty.current).length ? "dirty" : "saved");
          setMessage(null);
        }
      } catch (err) {
        if (!alive.current) return;
        if (err instanceof ApiError && err.status === 409) {
          setConflict(err.message);
        } else if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
          setStatus("error");
          setMessage(err.message);
        } else {
          setStatus("offline");
          timer.current = setTimeout(() => void flush(), 5000);
        }
      } finally {
        inflight.current = false;
      }
      if (alive.current && Object.keys(dirty.current).length && !timer.current && !conflict.current) timer.current = setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [itemId],
  );

  // leaving the book (navigation, tab hidden, closing) saves what is pending
  useEffect(() => {
    alive.current = true;
    const hide = () => {
      if (document.visibilityState === "hidden") void flush({ keepalive: true });
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", hide);
    return () => {
      alive.current = false;
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", hide);
      void flush({ keepalive: true });
    };
  }, [flush]);

  function change<K extends ReviewField>(k: K, v: ReviewValues[K]) {
    setValues((cur) => ({ ...cur, [k]: v }));
    if (same(v, base.current[k])) delete dirty.current[k];
    else dirty.current = { ...dirty.current, [k]: v };
    writeDraft(itemId, { baseVersion: version.current, fields: dirty.current });
    if (conflict.current) return; // never auto-save over a newer version
    setStatus(Object.keys(dirty.current).length ? "dirty" : "saved");
    setMessage(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), DEBOUNCE_MS);
  }

  /** the newest stored details become the base of the edits */
  async function loadNewest() {
    const r = await api<{ item: ReviewValues & { detailsVersion: number } }>(`/api/inventory/${itemId}`);
    version.current = r.item.detailsVersion;
    base.current = Object.fromEntries(REVIEW_FIELDS.map((f) => [f, r.item[f] ?? null])) as ReviewValues;
    conflict.current = false;
    return base.current;
  }
  /** conflict: apply my pending edits over the newest version (the reviewer saw the banner and chose it) */
  async function applyMineOverNewest() {
    try {
      const newest = await loadNewest();
      setValues({ ...newest, ...dirty.current });
      setStatus("dirty");
      setMessage(null);
      await flush();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  async function discardMine() {
    try {
      dirty.current = {};
      writeDraft(itemId, null);
      setValues(await loadNewest());
      setStatus("idle");
      setMessage(null);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function review(action: "start" | "approve") {
    if (action === "approve" && (Object.keys(dirty.current).length || status === "saving")) {
      await flush();
      if (Object.keys(dirty.current).length) {
        toast.warning("יש שינויים שלא נשמרו. שמרו אותם לפני האישור.");
        return;
      }
    }
    setBusy(action);
    try {
      const r = await api<{ reviewStatus: ItemReviewStatus }>(`/api/inventory/${itemId}/review`, { method: "POST", json: action === "start" ? { action } : { action, detailsVersion: version.current } });
      setReviewStatus(r.reviewStatus);
      toast.success(action === "start" ? "הבדיקה התחילה" : "פרטי הפריט אושרו");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function restore(runId: string) {
    if (!window.confirm("לשחזר את הערכים שהיו לפני הניתוח הזה? הערכים הנוכחיים של השדות שהניתוח שינה יוחלפו (ונשמרים בהיסטוריה).")) return;
    setBusy(`restore-${runId}`);
    try {
      const r = await api<{ fields: string[] }>(`/api/ai/runs/${runId}/restore`, { method: "POST" });
      toast.success(`שוחזרו ${r.fields.length} שדות`);
      const newest = await loadNewest();
      setValues({ ...newest, ...dirty.current });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const latest = ai.latest;
  const decisions = (latest?.applied?.decisions ?? {}) as Record<string, { action: string; proposed?: string | null; reason?: string } | undefined>;
  const evidence = (f: ReviewField) => {
    const r = latest?.result;
    if (!r) return null;
    if (f === "itemType") return { confidence: r.itemType.confidence, source: null as string | null, imageIds: [] as string[], note: r.itemType.note, status: "found" };
    if (f === "catalogHeadline" || f === "catalogDescription") return { confidence: r.catalog.confidence, source: null, imageIds: [], note: null, status: "found" };
    const x = r.fields[f];
    return { confidence: x.confidence, source: x.source, imageIds: x.imageIds, note: x.note, status: x.status };
  };
  const editable = canEdit && status !== "saving";
  const latestCompleted = ai.runs.find((r) => r.status === "COMPLETED" && !r.restoredAt);

  // one line per distinct remark (runs saved before the server-side dedupe can repeat a remark per field)
  const reviewList = [...new Map((latest?.applied?.review ?? []).map((r) => [r.reason.replace(/\s+/g, " ").trim(), r])).values()];
  const flagged = new Set(reviewList.map((r) => r.field));

  /**
   * One quiet line under a field: filled by the AI or not, and only what should make the reviewer look twice
   * (confidence below high, a value not read in the photos, a field the AI flagged). Image ids stay out of the UI.
   */
  function fieldHint(f: ReviewField) {
    if (f === "extent") return null; // counted by a person, never by the AI
    const d = decisions[f];
    const e = evidence(f);
    if (!d && !e) return null;
    const written = d?.action === "written";
    const doubtful = written && !!e && ((!!e.confidence && e.confidence !== "high") || (!!e.source && e.source !== "image"));
    const parts: React.ReactNode[] = [];
    if (written) parts.push(<span key="w" className="inline-flex items-center gap-1 text-info"><Sparkles className="size-3" aria-hidden />מולא ב-AI</span>);
    if (written && e?.confidence && e.confidence !== "high") parts.push(<span key="c" className={e.confidence === "low" ? "text-danger" : "text-warn"}>{CONFIDENCE[e.confidence]}</span>);
    if (written && e?.source && e.source !== "image") parts.push(<span key="s" className="text-warn">{SOURCE[e.source]}</span>);
    if (!written && e?.status === "unknown" && !values[f]) parts.push(<span key="st">ה-AI לא זיהה</span>);
    // why a field stayed empty is in the review list once; repeating it under every empty field is noise
    const note = e?.note && (doubtful || (flagged.has(f) && e.status === "found")) ? e.note : null;
    if (note) parts.push(<span key="n" className="text-ink-2" title={note}>{note.length > 160 ? `${note.slice(0, 160)}…` : note}</span>);
    const offered = (d?.action === "kept" || d?.action === "skipped_human_edit") && d.proposed ? d.proposed : null;
    const proposal = offered && !same(offered, values[f]) ? offered : null;
    // applied by the reviewer: offer to undo, back to the value from before the analysis
    const before = latest?.base ? ((latest.base as Record<string, string | null>)[f] ?? null) : null;
    const undo = offered && !proposal && !same(before, offered) ? before : undefined;
    if (!parts.length && !proposal && undo === undefined) return null;
    return (
      <span className="flex flex-col gap-1">
        {parts.length > 0 && <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">{parts.map((p, i) => <span key={i} className="inline-flex items-center gap-2">{i > 0 && <span aria-hidden>·</span>}{p}</span>)}</span>}
        {proposal && (
          <span className="rounded bg-info-soft px-2 py-1 text-ink-2">
            <Sparkles className="me-1 inline size-3 text-info" aria-hidden />
            הצעת AI: <span className="whitespace-pre-line text-ink">{proposal.length > 300 ? `${proposal.slice(0, 300)}…` : proposal}</span>
            {canEdit && (
              <button type="button" className="ms-2 font-medium text-info underline" onClick={() => change(f, proposal as ReviewValues[typeof f])}>
                החלת ההצעה
              </button>
            )}
          </span>
        )}
        {undo !== undefined && (
          <span className="text-ink-2">
            הוחלה הצעת ה-AI
            {canEdit && (
              <button type="button" className="ms-2 font-medium text-info underline" onClick={() => change(f, (undo ?? (f === "title" ? "" : null)) as ReviewValues[typeof f])}>
                ביטול ההחלה{undo ? ` (חזרה ל"${undo.length > 60 ? `${undo.slice(0, 60)}…` : undo}")` : ""}
              </button>
            )}
          </span>
        )}
      </span>
    );
  }

  const text = (f: Exclude<ReviewField, "itemType">, opts: { rows?: number; className?: string } = {}) => (
    <Field label={LABEL[f]} required={f === "title"} hint={fieldHint(f)} className={opts.className}>
      {(p) =>
        opts.rows ? (
          <Textarea {...p} rows={opts.rows} maxLength={MAX[f]} value={values[f] ?? ""} readOnly={!editable} onChange={(e) => change(f, e.target.value as ReviewValues[typeof f])} onBlur={() => void flush()} className={cn(dirty.current[f] !== undefined && "ring-1 ring-warn/40")} />
        ) : (
          <Input {...p} maxLength={MAX[f]} value={values[f] ?? ""} readOnly={!editable} onChange={(e) => change(f, e.target.value as ReviewValues[typeof f])} onBlur={() => void flush()} className={cn(dirty.current[f] !== undefined && "ring-1 ring-warn/40")} />
        )
      }
    </Field>
  );

  const applied = latest?.applied;
  const findings = latest?.result?.findings ?? [];
  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-2">
          פרטי הפריט ובדיקה
          <ReviewStatusBadge status={reviewStatus} />
        </span>
      }
      actions={
        <>
          <span className={cn("text-[12px]", status === "conflict" || status === "error" ? "text-danger" : status === "offline" ? "text-warn" : "text-muted")} role="status" aria-live="polite">
            {STATUS_TEXT[status]}
          </span>
          {canReview && (reviewStatus === "NOT_STARTED" || reviewStatus === "PENDING_REVIEW") && (
            <Button size="sm" icon={<ClipboardCheck />} loading={busy === "start"} onClick={() => void review("start")}>
              התחל בדיקה
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-5 px-5 py-4">
        {(ai.reviewChangedAt || latestCompleted) && (
          <p className="text-[12px] text-muted">
            {latestCompleted && <>נותח ב-AI {fmt.dateTime(new Date(latestCompleted.createdAt))}</>}
            {latestCompleted && ai.reviewChangedAt && " · "}
            {ai.reviewChangedAt && (
              <>
                {t.reviewStatus[reviewStatus]} {fmt.dateTime(new Date(ai.reviewChangedAt))}
                {ai.reviewChangedBy && <> · {ai.reviewChangedBy}</>}
              </>
            )}
            {ai.approvedAt && ai.approvedBy && reviewStatus === "APPROVED" && <> · אושר על ידי {ai.approvedBy}</>}
          </p>
        )}
        {reviewStatus !== "APPROVED" && ai.hasSuccessfulAnalysis && (
          <div className="rounded-md border border-warn/30 bg-warn-soft px-3.5 py-2.5 text-[13px]">
            <div className="font-medium text-ink">{reviewList.length ? `לבדוק לפני אישור (${reviewList.length})` : "הפרטים מולאו ב-AI וטרם אושרו"}</div>
            {reviewList.length > 0 && (
              <ul className="mt-1.5 list-disc space-y-1 ps-5 text-ink-2">
                {(showAllReview ? reviewList : reviewList.slice(0, REVIEW_PREVIEW)).map((r, i) => (
                  <li key={i}>{r.reason}</li>
                ))}
              </ul>
            )}
            {reviewList.length > REVIEW_PREVIEW && (
              <button type="button" className="mt-1.5 text-[12px] font-medium text-ink underline" onClick={() => setShowAllReview((s) => !s)}>
                {showAllReview ? "הצג פחות" : `הצג עוד ${reviewList.length - REVIEW_PREVIEW}`}
              </button>
            )}
            {!reviewList.length && <p className="mt-0.5 text-ink-2">בדקו אותם מול התמונות, תקנו לפי הצורך ואשרו.</p>}
          </div>
        )}
        {status === "conflict" && (
          <div className="rounded-md bg-danger-soft px-3 py-2.5 text-[13px] text-danger" role="alert">
            <p>{message}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void applyMineOverNewest()}>
                החלת השינויים שלי על הגרסה החדשה
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void discardMine()}>
                ביטול השינויים שלי וטעינת הגרסה החדשה
              </Button>
            </div>
          </div>
        )}
        {status === "error" && message && (
          <p className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
            {message}
          </p>
        )}

        <FieldGroup title="זיהוי הפריט">
          {text("title", { className: "sm:col-span-4" })}
          <Field label={LABEL.itemType} hint={fieldHint("itemType")} className="sm:col-span-2">
            {(p) => (
              <Select {...p} value={values.itemType} disabled={!editable} onChange={(e) => change("itemType", e.target.value as ItemType)} onBlur={() => void flush()}>
                {ITEM_TYPES.map((x) => (
                  <option key={x} value={x}>
                    {t.itemType[x]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {text("subtitle", { className: "sm:col-span-3" })}
          {text("author", { className: "sm:col-span-3" })}
        </FieldGroup>

        <FieldGroup title="פרטי הדפוס">
          {text("printPlace", { className: "sm:col-span-2" })}
          {text("printYear", { className: "sm:col-span-2" })}
          {text("publisher", { className: "sm:col-span-2" })}
          {text("edition", { className: "sm:col-span-3" })}
          {text("extent", { className: "sm:col-span-3" })}
        </FieldGroup>

        <FieldGroup title="תיאור העותק">
          {text("bibliographicNotes", { rows: 3, className: "sm:col-span-6" })}
          {text("conditionNotes", { rows: 2, className: "sm:col-span-6" })}
        </FieldGroup>

        <FieldGroup title="טיוטה לקטלוג" note={applied?.lot?.skippedReason ?? undefined}>
          {text("catalogHeadline", { className: "sm:col-span-6" })}
          {text("catalogDescription", { rows: 9, className: "sm:col-span-6" })}
        </FieldGroup>

        {latest?.result && (latest.result.identification.summary || findings.length > 0 || latest.images.some((i) => i.status === "skipped")) && (
          <section className="space-y-2.5 border-t border-rule pt-4 text-[13px]">
            <h3 className="text-[12px] font-semibold text-muted">מה זוהה בתמונות</h3>
            {latest.result.identification.summary && <p className="text-ink-2">{latest.result.identification.summary}</p>}
            {findings.length > 0 && (
              <ul className="space-y-1.5">
                {findings.map((f, i) => (
                  <li key={i} className="rounded-md bg-stone-2 px-3 py-2">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium text-ink">{FINDING[f.kind] ?? f.kind}</span>
                      <span className={cn("text-[12px]", f.reading === "certain" ? "text-muted" : "text-warn")}>{READING[f.reading]}</span>
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
            )}
            {latest.images.some((i) => i.status === "skipped") && (
              <p className="text-[12px] text-warn">
                תמונות שלא נשלחו לניתוח: {latest.images.filter((i) => i.status === "skipped").map((i) => `${t.categoryShort[i.category as keyof typeof t.categoryShort] ?? i.category} (${i.reason})`).join(" · ")}
              </p>
            )}
          </section>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-4">
          {canReview && reviewStatus !== "APPROVED" && (
            <Button variant="primary" icon={<CheckCircle2 />} loading={busy === "approve"} disabled={status === "conflict" || ai.aiStatus === "QUEUED" || ai.aiStatus === "RUNNING"} onClick={() => void review("approve")}>
              סיימתי לבדוק - אשר פרטים
            </Button>
          )}
          {ai.runs.length > 0 && (
            <Button variant="ghost" size="sm" icon={<History />} onClick={() => setShowRuns((s) => !s)}>
              היסטוריית ניתוחי AI ({ai.runs.length})
            </Button>
          )}
        </div>

        {showRuns && applied && applied.warnings.length > 0 && (
          <div className="rounded-md bg-stone-2 px-3 py-2 text-[12px] text-ink-2">
            <div className="font-medium">הערות טכניות מהניתוח האחרון</div>
            {applied.warnings.map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </div>
        )}
        {showRuns && (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-rule text-muted">
                  <th className="px-2 py-1.5 text-start font-medium">מועד</th>
                  <th className="px-2 py-1.5 text-start font-medium">ספק / מודל</th>
                  <th className="px-2 py-1.5 text-start font-medium">מצב</th>
                  <th className="px-2 py-1.5 text-start font-medium">תמונות</th>
                  <th className="px-2 py-1.5 text-start font-medium">טוקנים (נכנס / יוצא)</th>
                  <th className="px-2 py-1.5 text-start font-medium">עלות</th>
                  <th className="px-2 py-1.5 text-start font-medium">זמן</th>
                  <th className="px-2 py-1.5 text-start font-medium">הפעיל / אישר</th>
                  <th className="px-2 py-1.5" aria-label="פעולות" />
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {ai.runs.map((r) => (
                  <tr key={r.id}>
                    <td className="px-2 py-1.5">{fmt.dateTime(new Date(r.createdAt))}</td>
                    <td className="px-2 py-1.5" dir="ltr">
                      {r.provider} · {r.model}
                    </td>
                    <td className="px-2 py-1.5">
                      {t.aiStatus[r.status]}
                      {r.isReanalysis && " · חוזר"}
                      {r.restoredAt && " · שוחזר"}
                      {r.error && <div className="text-danger">{r.error}</div>}
                    </td>
                    <td className="num px-2 py-1.5">{r.imageCount}</td>
                    <td className="num px-2 py-1.5">
                      {r.inputTokens ?? "-"} / {r.outputTokens ?? "-"}
                      {r.cachedInputTokens ? ` (${r.cachedInputTokens} במטמון)` : ""}
                    </td>
                    <td className="num px-2 py-1.5">
                      {r.costUsd === null ? "-" : `$${r.costUsd.toFixed(4)}`}
                      {r.costUsd !== null && r.costEstimated && " (הערכה)"}
                    </td>
                    <td className="num px-2 py-1.5">{r.durationMs === null ? "-" : `${Math.round(r.durationMs / 1000)} ש׳`}</td>
                    <td className="px-2 py-1.5">
                      {r.requestedBy ?? "-"}
                      {r.approvedBy && <div className="text-muted">אישר: {r.approvedBy}</div>}
                    </td>
                    <td className="px-2 py-1.5">
                      {canRestore && latestCompleted?.id === r.id && (
                        <Button size="sm" variant="ghost" icon={<RotateCcw />} loading={busy === `restore-${r.id}`} onClick={() => void restore(r.id)}>
                          שחזור
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}
