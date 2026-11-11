"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ClipboardCheck, FileText, GitCompare, History, RotateCcw, Sparkles } from "lucide-react";
import { BOOK_SIZES, ITEM_TYPES, type BookSize, type ItemReviewStatus, type ItemType } from "@avot/shared";
import { Button } from "@/components/ui/button";
import { ReviewStatusBadge } from "@/components/ui/badge";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Panel } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/dialog";
import { OPEN_DETAILS_EVENT } from "@/lib/item-events";
import { ConsignorSelect } from "@/components/consignors/consignor-select";
import type { ConsignorLite } from "@/components/consignors/consignor-dialog";
import { useToast } from "@/components/ui/toast";
import { fmt, t } from "@/i18n";
import { ApiError, api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { RichTextEditor } from "@/components/ui/rich-text";
import { ITEM_FORMAT_FIELDS, hasFormatting, plainText, readTextFormat, segmentsFor, serializeItemFormat, type Segment } from "@/lib/rich-text";
import type { AiState } from "@/server/services/ai-analysis";
import { RunCompare } from "./run-compare";

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
/**
 * The formatting (bold / underline / color) of the long texts travels as one more value: a JSON string of
 * { field: segments }, so the draft, the dirty tracking and the autosave treat it like any other text field.
 */
export type ReviewKey = ReviewField | "textFormat" | AdminKey;
/**
 * The administrative details of the full-details window (not written by the AI): they travel through the very same
 * draft / autosave / version check as the review fields, so there is one save mechanism and one source of truth.
 * Numbers are held as text while typing ("" = none).
 */
export const ADMIN_KEYS = ["internalNotes", "heightMm", "widthMm", "depthMm", "sizeCategory", "barcode", "consignorId"] as const;
export type AdminKey = (typeof ADMIN_KEYS)[number];
export type AdminValues = { internalNotes: string | null; heightMm: string | null; widthMm: string | null; depthMm: string | null; sizeCategory: BookSize; barcode: string | null; consignorId: string | null };
export type ReviewValues = { [K in ReviewField]: K extends "itemType" ? ItemType : K extends "title" ? string : string | null } & { textFormat: string | null } & AdminValues;
/** a short, human summary of who did what to the details, for the reviewer (computed on the server from the history) */
export interface ReviewSummary {
  startedBy: string | null;
  startedAt: string | null;
  lastEditBy: string | null;
  lastEditAt: string | null;
  aiAdditionBy: string | null;
  aiAdditionAt: string | null;
  /** the approval that stood before the last material change */
  previousApprovedBy: string | null;
  previousApprovedAt: string | null;
}
const MM_KEYS = ["heightMm", "widthMm", "depthMm"] as const;


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
  catalogDescription: "תיאור קטלוגי",
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
  canApprove,
  canRestore,
  canRewrite = false,
  canApply = false,
  inventoryNumber,
  consignor: serverConsignor,
  summary,
}: {
  itemId: string;
  values: ReviewValues;
  detailsVersion: number;
  ai: AiState;
  canEdit: boolean;
  /** may start a review (item.review) */
  canReview: boolean;
  /** may give the final approval (item.review.approve); the server checks it again */
  canApprove: boolean;
  inventoryNumber: string;
  /** the book's consignor (name for the picker); null on books that predate consignors */
  consignor: ConsignorLite | null;
  summary: ReviewSummary;
  canRestore: boolean;
  /** "שכתוב ב-AI" of the catalog draft (editor with AI access, provider configured) */
  canRewrite?: boolean;
  /** apply a saved (re-analysis) result to the item, and compare runs */
  canApply?: boolean;
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
  const [additions, setAdditions] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [compare, setCompare] = useState<{ a: string; b: string } | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [consignor, setConsignor] = useState<ConsignorLite | null>(serverConsignor);
  /** the pending edits came from an applied AI addition: the history says so */
  const aiOrigin = useRef(false);

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

  // the pencil at the top of the page and "פרטי הספר המלאים" open the same window
  useEffect(() => {
    const open = () => setDetailsOpen(true);
    window.addEventListener(OPEN_DETAILS_EVENT, open);
    return () => window.removeEventListener(OPEN_DETAILS_EVENT, open);
  }, []);

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
    const pending = Object.fromEntries(Object.entries(d.fields).filter(([k, v]) => !same(v, serverValues[k as ReviewKey]))) as Partial<ReviewValues>;
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
        const body: Record<string, unknown> = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === "string" ? (v.trim() ? v : null) : v]));
        if ("textFormat" in body) body.textFormat = body.textFormat ? JSON.parse(body.textFormat as string) : null;
        for (const k of MM_KEYS) if (k in body) body[k] = body[k] === null ? null : Number(body[k]);
        // a barcode or a consignor can be replaced, never emptied; the default barcode is the inventory number
        if ("barcode" in body && (!body.barcode || body.barcode === inventoryNumber)) delete body.barcode;
        if ("consignorId" in body && !body.consignorId) delete body.consignorId;
        const viaAi = aiOrigin.current;
        const r = await api<{ detailsVersion: number; reviewStatus: ItemReviewStatus }>(`/api/inventory/${itemId}`, { method: "PATCH", json: { ...body, expectedVersion: version.current, editSource: viaAi ? "ai" : "manual" }, keepalive: opts.keepalive });
        if (viaAi && !Object.keys(dirty.current).some((k) => !(k in fields))) aiOrigin.current = false;
        version.current = r.detailsVersion;
        base.current = { ...base.current, ...fields };
        // edits typed while the request was out stay dirty
        for (const [k, v] of Object.entries(fields)) if (same(dirty.current[k as ReviewKey], v)) delete dirty.current[k as ReviewKey];
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

  function change<K extends ReviewKey>(k: K, v: ReviewValues[K]) {
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
    const r = await api<{ item: Record<ReviewField, string | null> & { textFormat: unknown; detailsVersion: number; heightMm: number | null; widthMm: number | null; depthMm: number | null; sizeCategory: BookSize; internalNotes: string | null; barcode: string; consignor: ConsignorLite | null } }>(`/api/inventory/${itemId}`);
    version.current = r.item.detailsVersion;
    const admin: AdminValues = {
      internalNotes: r.item.internalNotes,
      heightMm: r.item.heightMm === null ? null : String(r.item.heightMm),
      widthMm: r.item.widthMm === null ? null : String(r.item.widthMm),
      depthMm: r.item.depthMm === null ? null : String(r.item.depthMm),
      sizeCategory: r.item.sizeCategory,
      barcode: r.item.barcode !== inventoryNumber ? r.item.barcode : null,
      consignorId: r.item.consignor?.id ?? null,
    };
    setConsignor(r.item.consignor ? { id: r.item.consignor.id, name: r.item.consignor.name } : null);
    base.current = { ...(Object.fromEntries(REVIEW_FIELDS.map((f) => [f, r.item[f] ?? null])) as unknown as Omit<ReviewValues, "textFormat" | AdminKey>), textFormat: serializeItemFormat(r.item.textFormat), ...admin };
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

  /**
   * "הוספת מידע ב-AI": saves pending edits first, then queues a job on the SERVER. The page may be closed: the server
   * applies the result (or keeps it as a proposal if somebody edited meanwhile) and every user sees the same state.
   */
  async function rewrite() {
    if (!additions.trim()) {
      toast.warning("כתבו את המידע להוספה או את התיקון המבוקש");
      return;
    }
    await flush();
    if (Object.keys(dirty.current).length) {
      toast.warning("יש שינויים שלא נשמרו. שמרו אותם לפני ההוספה.");
      return;
    }
    setBusy("rewrite");
    try {
      await api(`/api/inventory/${itemId}/ai/rewrite`, { method: "POST", json: { additions, mode: "patch", requestKey: crypto.randomUUID() } });
      setAdditions("");
      toast.info("ההוספה נשלחה לעיבוד ברקע", { detail: "אפשר להמשיך לעבוד או לצאת מהדף. התוצאה תישמר בשרת ותופיע לכל המשתמשים." });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  /** the server puts back the values (and their formatting) the addition replaced, never over a newer edit */
  async function undoRewrite(runId: string) {
    setBusy("undo");
    try {
      const r = await api<{ fields: string[]; kept: string[] }>(`/api/ai/runs/${runId}/rewrite/undo`, { method: "POST" });
      toast.success(`ההוספה בוטלה (${r.fields.map((f) => LABEL[f as ReviewField] ?? f).join(", ")})`, r.kept.length ? { detail: `לא בוטלו שדות ששונו מאז: ${r.kept.map((f) => LABEL[f as ReviewField] ?? f).join(", ")}` } : undefined);
      const newest = await loadNewest();
      setValues({ ...newest, ...dirty.current });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  /** a result the server held back because the details changed while the model worked */
  async function applyProposal(runId: string) {
    setBusy("proposal");
    try {
      const r = await api<{ fields: string[] }>(`/api/ai/runs/${runId}/rewrite/apply`, { method: "POST" });
      toast.success(`ההצעה הוחלה (${r.fields.map((f) => LABEL[f as ReviewField] ?? f).join(", ")})`);
      const newest = await loadNewest();
      setValues({ ...newest, ...dirty.current });
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
  const lastRewrite = ai.rewrites[0] ?? null;
  /** a name the last addition proposed: never applied by itself (the item's name is the person's), offered under the field */
  const titleProposal = lastRewrite?.status === "COMPLETED" && lastRewrite.titleProposal && !same(lastRewrite.titleProposal, values.title) ? { title: lastRewrite.titleProposal, before: values.title } : null;
  const decisions = (latest?.applied?.decisions ?? {}) as Record<string, { action: string; proposed?: string | null; reason?: string } | undefined>;
  const evidence = (f: ReviewField) => {
    const r = latest?.result;
    if (!r) return null;
    if (f === "itemType") return { confidence: r.itemType.confidence, source: null as string | null, imageIds: [] as string[], note: r.itemType.note, status: "found" };
    if (f === "catalogHeadline" || f === "catalogDescription") return { confidence: r.catalog.confidence, source: null, imageIds: [], note: null, status: "found" };
    const x = r.fields[f];
    return { confidence: x.confidence, source: x.source, imageIds: x.imageIds, note: x.note, status: x.status };
  };
  const editable = canEdit;
  const latestCompleted = ai.runs.find((r) => r.status === "COMPLETED" && !r.restoredAt && r.applied);

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
    const fromRewrite = f === "title" && titleProposal ? titleProposal : null;
    const offered = fromRewrite ? fromRewrite.title : (d?.action === "kept" || d?.action === "skipped_human_edit") && d.proposed ? d.proposed : null;
    const proposal = offered && !same(offered, values[f]) ? offered : null;
    // applied by the reviewer: offer to undo, back to the value from before the analysis (or the rewrite)
    const before = fromRewrite ? fromRewrite.before : latest?.base ? ((latest.base as Record<string, string | null>)[f] ?? null) : null;
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

  const formats = useMemo(() => {
    try {
      return readTextFormat(JSON.parse(values.textFormat ?? "null"), ITEM_FORMAT_FIELDS);
    } catch {
      return {};
    }
  }, [values.textFormat]);
  /** a rich field: the text and its formatting change together (the formatting is dropped by the server if it stops matching) */
  function changeRich(f: (typeof ITEM_FORMAT_FIELDS)[number], segs: Segment[]) {
    const next = { ...formats };
    if (hasFormatting(segs)) next[f] = segs;
    else delete next[f];
    change(f, plainText(segs) as ReviewValues[typeof f]);
    change("textFormat", Object.keys(next).length ? JSON.stringify(next) : null);
  }
  const isRich = (f: ReviewField): f is (typeof ITEM_FORMAT_FIELDS)[number] => (ITEM_FORMAT_FIELDS as readonly string[]).includes(f);

  const text = (f: Exclude<ReviewField, "itemType">, opts: { rows?: number; className?: string } = {}) => (
    <Field label={LABEL[f]} required={f === "title"} hint={fieldHint(f)} className={opts.className}>
      {(p) =>
        opts.rows && isRich(f) ? (
          <RichTextEditor
            {...p}
            aria-label={LABEL[f]}
            rows={opts.rows}
            maxLength={MAX[f]}
            value={segmentsFor(values[f], formats[f])}
            disabled={!editable}
            onChange={(segs) => changeRich(f, segs)}
            className={cn(dirty.current[f] !== undefined && "ring-1 ring-warn/40")}
          />
        ) : opts.rows ? (
          <Textarea {...p} rows={opts.rows} maxLength={MAX[f]} value={values[f] ?? ""} readOnly={!editable} onChange={(e) => change(f, e.target.value as ReviewValues[typeof f])} onBlur={() => void flush()} className={cn(dirty.current[f] !== undefined && "ring-1 ring-warn/40")} />
        ) : (
          <Input {...p} maxLength={MAX[f]} value={values[f] ?? ""} readOnly={!editable} onChange={(e) => change(f, e.target.value as ReviewValues[typeof f])} onBlur={() => void flush()} className={cn(dirty.current[f] !== undefined && "ring-1 ring-warn/40")} />
        )
      }
    </Field>
  );

  const applied = latest?.applied;
  const approved = reviewStatus === "APPROVED";
  const busyAi = ai.aiStatus === "QUEUED" || ai.aiStatus === "RUNNING";
  const when = (iso: string | null) => (iso ? fmt.dateTime(new Date(iso)) : "");

  async function closeDetails() {
    setDetailsOpen(false);
    await flush();
  }

  /** the few lines the reviewer needs: where the book stands, who touched it, whether the AI added anything */
  const summaryBlock = (
    <div className="rounded-md bg-stone-2/60 px-3.5 py-3 text-[13px] leading-relaxed" data-testid="review-summary">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-ink">
          {reviewStatus === "NOT_STARTED" ? "הספר טרם נותח" : reviewStatus === "PENDING_REVIEW" ? "ממתין לבדיקה - עדיין לא התחילה בדיקה אנושית" : reviewStatus === "IN_REVIEW" ? "בבדיקה" : "מאושר"}
        </span>
        {reviewStatus === "IN_REVIEW" && summary.startedBy && (
          <span className="text-ink-2">
            · הבדיקה התחילה על ידי {summary.startedBy} {when(summary.startedAt)}
          </span>
        )}
        {approved && ai.approvedBy && (
          <span className="text-ink-2">
            · אושר על ידי {ai.approvedBy}
            {ai.approvedAt ? ` ${when(ai.approvedAt)}` : ""}
          </span>
        )}
      </div>
      <ul className="mt-1 space-y-0.5 text-[12.5px] text-ink-2">
        {summary.lastEditBy && (
          <li>
            נערך לאחרונה על ידי {summary.lastEditBy} · {when(summary.lastEditAt)}
          </li>
        )}
        {summary.aiAdditionAt && (
          <li>
            הוספת מידע באמצעות AI: {summary.aiAdditionBy ?? "משתמש"} · {when(summary.aiAdditionAt)}
          </li>
        )}
        {latestCompleted && <li>נותח ב-AI {fmt.dateTime(new Date(latestCompleted.createdAt))}</li>}
        {!approved && summary.previousApprovedBy && (
          <li className="text-warn">
            האישור הקודם ({summary.previousApprovedBy}, {when(summary.previousApprovedAt)}) בוטל בגלל שינוי בפרטים - נדרש אישור חדש
          </li>
        )}
        {!approved && reviewList.length > 0 && <li className="text-warn">יש {reviewList.length} הערות AI שדורשות תשומת לב</li>}
      </ul>
      <a href="#item-history" className="mt-1 inline-block text-[12px] font-medium text-info underline">
        היסטוריית פעולות מפורטת
      </a>
    </div>
  );

  const aiAdditions = canRewrite && canEdit && (
    <div className="space-y-2.5 rounded-md border border-rule bg-stone-2/50 p-3">
      <Field label="הוספת מידע או תיקון" hint="מה שבדקתם ולא מופיע בפרטים, או מה שצריך לתקן: ייחוס חתימה, מקור העותק, רקע, ממצא מיוחד, שנה או שם. ה-AI יוסיף או יתקן רק את זה, במקום המתאים, בלי לנסח מחדש שדות ופסקאות שלא ביקשתם לשנות, ויישמר את ההדגשות הקיימות. העיבוד רץ בשרת: אפשר לצאת מהדף, וההוספה חלה מיד בסיומה ואפשר לבטל אותה.">
        {(p) => <Textarea {...p} rows={3} maxLength={4000} value={additions} onChange={(e) => setAdditions(e.target.value)} placeholder="למשל: החתימה בשער היא של רבי משה סופר. העותק מספריית בית המדרש בפרשבורג." />}
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="primary" icon={<Sparkles />} loading={busy === "rewrite"} disabled={!!busy || busyAi} onClick={() => void rewrite()}>
          הוספת המידע ב-AI
        </Button>
        {busyAi && <span className="text-[12px] text-ink-2">פעולת AI פעילה על הספר, אפשר להוסיף מידע בסיומה.</span>}
        {lastRewrite?.undoable && !busyAi && (
          <span className="text-[12px] text-ink-2">
            ההוספה האחרונה הוחלה ({lastRewrite.fields.map((f) => LABEL[f as ReviewField] ?? f).join(", ")}
            {lastRewrite.requestedBy ? ` · ${lastRewrite.requestedBy}` : ""})
            <button type="button" className="ms-2 inline-flex min-h-8 items-center font-medium text-info underline disabled:opacity-50" disabled={!!busy} onClick={() => void undoRewrite(lastRewrite.id)}>
              ביטול ההוספה
            </button>
          </span>
        )}
      </div>
      {lastRewrite?.proposalPending && !busyAi && (
        <div className="rounded-md bg-warn-soft px-3 py-2 text-[12.5px] text-warn" role="alert" data-testid="rewrite-conflict">
          <p>
            בזמן שה-AI עיבד את ההוספה{lastRewrite.requestedBy ? ` של ${lastRewrite.requestedBy}` : ""}, הפרטים נערכו על ידי משתמש אחר, ולכן התוצאה לא הוחלה אוטומטית ולא דרסה את העריכה החדשה. היא נשמרה כהצעה.
          </p>
          <Button size="sm" className="mt-2" loading={busy === "proposal"} disabled={!!busy} onClick={() => void applyProposal(lastRewrite.id)}>
            החלת ההצעה בצורה בטוחה
          </Button>
        </div>
      )}
      {lastRewrite?.status === "FAILED" && !busyAi && (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger" role="alert">
          ההוספה האחרונה נכשלה{lastRewrite.requestedBy ? ` (${lastRewrite.requestedBy})` : ""}: {lastRewrite.error ?? "שגיאה לא ידועה"}. הפרטים לא שונו.
        </p>
      )}
      {lastRewrite && lastRewrite.skipped.length > 0 && !busyAi && (
        <div className="rounded-md bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
          חלק מהפעולות לא בוצעו כי לא ניתן היה לאמת אותן מול הטקסט הנוכחי: {lastRewrite.skipped.map((x) => `${LABEL[x.field as ReviewField] ?? x.field} (${x.reason})`).join("; ")}
        </div>
      )}
    </div>
  );

  const num = (k: (typeof MM_KEYS)[number], label: string) => (
    <Field label={label} className="sm:col-span-2">
      {(p) => <Input {...p} type="number" min={1} max={5000} inputMode="numeric" className={cn("num", dirty.current[k] !== undefined && "ring-1 ring-warn/40")} readOnly={!editable} value={values[k] ?? ""} onChange={(e) => change(k, (e.target.value.trim() ? e.target.value.trim() : null) as ReviewValues[typeof k])} onBlur={() => void flush()} />}
    </Field>
  );

  return (
    <>
      <Panel
        title={
          <span className="flex flex-wrap items-center gap-2">
            תוכן לפרסום בקטלוג
            <ReviewStatusBadge status={reviewStatus} />
          </span>
        }
        actions={
          <span className={cn("text-[12px]", status === "conflict" || status === "error" ? "text-danger" : status === "offline" ? "text-warn" : "text-muted")} role="status" aria-live="polite">
            {STATUS_TEXT[status]}
          </span>
        }
      >
        <div className="space-y-4 px-4 py-4 sm:px-5">
          {summaryBlock}
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


          <div className="space-y-4" id="catalog-content">
            {text("catalogHeadline", { className: "text-[16px] font-semibold" })}
            {text("catalogDescription", { rows: 10 })}
            {applied?.lot?.skippedReason && <p className="text-[12px] text-muted">{applied.lot.skippedReason}</p>}
          </div>
          {aiAdditions}

          <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-4">
            {canReview && (reviewStatus === "NOT_STARTED" || reviewStatus === "PENDING_REVIEW") && (
              <Button icon={<ClipboardCheck />} loading={busy === "start"} onClick={() => void review("start")}>
                התחל בדיקה
              </Button>
            )}
            {canApprove && !approved && (
              <Button variant="primary" icon={<CheckCircle2 />} loading={busy === "approve"} disabled={status === "conflict" || busyAi} onClick={() => void review("approve")}>
                סיום בדיקה ואישור
              </Button>
            )}
            <Button variant="ghost" icon={<FileText />} onClick={() => setDetailsOpen(true)}>
              פרטי הספר המלאים
            </Button>
            {ai.runs.length > 0 && (
              <Button variant="ghost" size="sm" icon={<History />} onClick={() => setShowRuns((s) => !s)}>
                היסטוריית ניתוחי AI ({ai.runs.length})
              </Button>
            )}
          </div>
          {!canApprove && !approved && <p className="text-[12px] text-muted">האישור הסופי של הפרטים נעשה על ידי משתמש מורשה.</p>}

        {showRuns && applied && applied.warnings.length > 0 && (
          <div className="rounded-md bg-stone-2 px-3 py-2 text-[12px] text-ink-2">
            <div className="font-medium">הערות טכניות מהניתוח האחרון</div>
            {applied.warnings.map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </div>
        )}
        {showRuns && picked.length === 2 && canApply && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" icon={<GitCompare />} onClick={() => setCompare({ a: picked[1]!, b: picked[0]! })}>
              השוואת ניתוחים
            </Button>
            <span className="text-[12px] text-muted">סומנו שני ניתוחים: אפשר להשוות ביניהם.</span>
          </div>
        )}
        {showRuns && compare && <RunCompare itemId={itemId} aId={compare.a} bId={compare.b} canApply={canApply} onClose={() => setCompare(null)} onApplied={() => { setCompare(null); setPicked([]); void loadNewest().then((n) => setValues({ ...n, ...dirty.current })); router.refresh(); }} />}
        {showRuns && (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-rule text-muted">
                  {canApply && <th className="w-8 px-2 py-1.5" aria-label="בחירה להשוואה" />}
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
                    {canApply && (
                      <td className="px-2 py-1.5">
                        {r.status === "COMPLETED" && (
                          <input
                            type="checkbox"
                            className="size-4 cursor-pointer accent-[var(--color-ink)]"
                            checked={picked.includes(r.id)}
                            disabled={!picked.includes(r.id) && picked.length >= 2}
                            onChange={() => setPicked((p) => (p.includes(r.id) ? p.filter((x) => x !== r.id) : [...p, r.id]))}
                            aria-label={`בחירת הניתוח מ-${fmt.dateTime(new Date(r.createdAt))} להשוואה`}
                          />
                        )}
                      </td>
                    )}
                    <td className="px-2 py-1.5">{fmt.dateTime(new Date(r.createdAt))}</td>
                    <td className="px-2 py-1.5" dir="ltr">
                      {r.provider} · {r.model}
                      {r.settingsVersion !== null && <div className="text-[11px] text-muted">הגדרות v{r.settingsVersion}</div>}
                    </td>
                    <td className="px-2 py-1.5">
                      {t.aiStatus[r.status]}
                      {r.pendingApply && <span className="text-info"> · שמור להשוואה, טרם הוחל</span>}
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
                      {canApply && r.pendingApply && latest && (
                        <Button size="sm" variant="ghost" icon={<GitCompare />} onClick={() => setCompare({ a: latest.id, b: r.id })}>
                          השוואה
                        </Button>
                      )}
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

      <Dialog
        open={detailsOpen}
        onClose={() => void closeDetails()}
        title={`פרטי הספר המלאים · ${inventoryNumber}`}
        description="כל פרטי הספר במקום אחד. השינויים נשמרים אוטומטית, יחד עם הכותרת והתיאור הקטלוגיים."
        width="xl"
        footer={
          <>
            <Button onClick={() => void closeDetails()}>סגירה</Button>
            <span className={cn("text-[12px]", status === "conflict" || status === "error" ? "text-danger" : status === "offline" ? "text-warn" : "text-muted")} role="status" aria-live="polite">
              {STATUS_TEXT[status]}
            </span>
          </>
        }
      >
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

        <div className="space-y-5">
          <FieldGroup title="זיהוי הספר">
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

          <FieldGroup title="מידע ביבליוגרפי">
            {text("bibliographicNotes", { rows: 3, className: "sm:col-span-6" })}
            {text("conditionNotes", { rows: 2, className: "sm:col-span-6" })}
          </FieldGroup>

          <FieldGroup title="מידע מנהלי">
            <Field label="מפקיד" hint={!consignor ? "ספר ישן ללא מפקיד - אפשר להשלים כאן" : undefined} className="sm:col-span-6">
              {(p) => (
                <ConsignorSelect
                  id={p.id}
                  value={consignor}
                  onChange={(c) => {
                    setConsignor(c);
                    if (c) change("consignorId", c.id);
                  }}
                />
              )}
            </Field>
            {num("heightMm", "גובה (מ״מ)")}
            {num("widthMm", "רוחב (מ״מ)")}
            {num("depthMm", "עובי (מ״מ)")}
            <Field label="קטגוריית גודל" hint="ריק = לפי המידות" className="sm:col-span-3">
              {(p) => (
                <Select {...p} value={values.sizeCategory} disabled={!editable} onChange={(e) => change("sizeCategory", e.target.value as BookSize)} onBlur={() => void flush()}>
                  {BOOK_SIZES.map((x) => (
                    <option key={x} value={x}>
                      {x === "UNKNOWN" ? "אוטומטי / לא ידוע" : t.bookSize[x]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="ברקוד חיצוני (אופציונלי)" hint="רק אם על המארז כבר מודבק ברקוד אחר. ברירת מחדל: מספר המלאי." className="sm:col-span-3">
              {(p) => <Input {...p} dir="ltr" maxLength={64} className={cn("font-mono", dirty.current.barcode !== undefined && "ring-1 ring-warn/40")} readOnly={!editable} value={values.barcode ?? ""} onChange={(e) => change("barcode", e.target.value as ReviewValues["barcode"])} onBlur={() => void flush()} />}
            </Field>
            <Field label="הערות פנימיות" className="sm:col-span-6">
              {(p) => <Textarea {...p} rows={2} maxLength={5000} readOnly={!editable} value={values.internalNotes ?? ""} onChange={(e) => change("internalNotes", e.target.value as ReviewValues["internalNotes"])} onBlur={() => void flush()} className={cn(dirty.current.internalNotes !== undefined && "ring-1 ring-warn/40")} />}
            </Field>
          </FieldGroup>

        </div>
      </Dialog>
    </>
  );
}
