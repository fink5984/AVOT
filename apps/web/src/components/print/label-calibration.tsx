"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_LABEL_PROFILES, FONT_STYLES, FONT_STYLE_NAMES, LABEL_TYPES, LABEL_TYPE_NAMES, type LabelProfile, type LabelType } from "@avot/shared";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { Panel } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";

interface Template {
  type: LabelType;
  profile: LabelProfile;
  defaults: LabelProfile;
  customised: boolean;
}
interface Info {
  widthMm: number;
  heightMm: number;
  barcodeModuleMm: number | null;
  barcodeWidthMm: number | null;
  barcodeFits: boolean;
}

const STOCKS = ["50x25", "57x32", "70x40", "100x50"];
const BOOK_SAMPLES = ["נועם אלימלך", 'שו"ת חתם סופר', "שם ארוך — בשתי שורות"];

function Slider({ label, value, min, max, step, unit = "מ״מ", onChange }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <label className="block text-[13px]">
      <span className="mb-1 flex justify-between">
        <span>{label}</span>
        <span className="num text-muted">
          {value} {unit}
        </span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--color-ink)]" dir="ltr" />
    </label>
  );
}

/**
 * Label calibration, once, by the manager: book / shelf / column labels with a live preview made by the real label engine
 * (the same layout and rasteriser the printer gets). Saving changes every place that prints; workers just click the printer icon.
 */
export function LabelCalibration({ printerId, labelSize, dotsPerMm }: { printerId: string | null; labelSize: string; dotsPerMm: number }) {
  const toast = useToast();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [type, setType] = useState<LabelType>("BOOK");
  const [stock, setStock] = useState(STOCKS.includes(labelSize) ? labelSize : "57x32");
  const [draft, setDraft] = useState<LabelProfile | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [sample, setSample] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    api<{ templates: Template[] }>("/api/print/templates")
      .then((r) => setTemplates(r.templates))
      .catch((e) => toast.error(errorMessage(e)));
  }, [toast]);

  const current = templates?.find((t) => t.type === type);
  useEffect(() => {
    if (current) setDraft(current.profile);
  }, [current?.type, current?.profile]); // eslint-disable-line react-hooks/exhaustive-deps

  // live preview of the (possibly unsaved) values
  useEffect(() => {
    if (!draft) return;
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const q = new URLSearchParams({ type, stock, dpm: String(dotsPerMm === 12 ? 12 : 8), profile: JSON.stringify(draft), sample: String(sample) });
        const r = await fetch(`/api/print/preview?${q}`, { credentials: "same-origin" });
        if (!r.ok) return;
        const blob = await r.blob();
        if (id !== reqId.current) return;
        setPreviewUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(blob);
        });
        const raw = r.headers.get("x-label-info");
        if (raw) setInfo(JSON.parse(decodeURIComponent(raw)) as Info);
      } catch {
        /* the next change retries */
      }
    }, 180);
    return () => clearTimeout(t);
  }, [draft, type, stock, dotsPerMm, sample]);

  const dirty = !!draft && !!current && JSON.stringify(draft) !== JSON.stringify(current.profile);
  const set = useCallback((patch: Partial<LabelProfile>) => setDraft((d) => (d ? { ...d, ...patch } : d)), []);

  async function save() {
    if (!draft) return false;
    setBusy(true);
    try {
      await api(`/api/print/templates/${type}`, { method: "PUT", json: { profile: draft } });
      // the typeface is one setting for every label type
      setTemplates((ts) => ts?.map((t) => (t.type === type ? { ...t, profile: draft, customised: true } : { ...t, profile: { ...t.profile, fontStyle: draft.fontStyle } })) ?? ts);
      toast.success("העיצוב נשמר — כל נקודות ההדפסה משתמשות בו");
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    try {
      const r = await api<{ profile: LabelProfile }>(`/api/print/templates/${type}`, { method: "DELETE" });
      setTemplates((ts) => ts?.map((t) => (t.type === type ? { ...t, profile: r.profile, customised: false } : t)) ?? ts);
      setDraft(r.profile);
      toast.success("הוחזר עיצוב ברירת המחדל");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function testPrint() {
    if (!printerId) return;
    if (dirty && !(await save())) return;
    setBusy(true);
    try {
      await api(`/api/print/printers/${printerId}/test?kind=${type}`, { method: "POST" });
      toast.success("תווית ניסיון נשלחה להדפסה", { detail: "ההדפסה תתבצע במדפסת הקבועה" });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="עיצוב ותצוגה מקדימה של תוויות">
      <div className="space-y-4 px-5 py-4">
        <p className="text-[13px] text-muted">מגדירים פעם אחת. כל התוויות — מטבלת המלאי, מדף ספר, ממסך המחסן — יוצאות באותו עיצוב. העובדים רק לוחצים על אייקון המדפסת.</p>
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="סוג תווית" className="flex gap-0.5 rounded-lg bg-stone p-0.5">
            {LABEL_TYPES.map((t) => (
              <button key={t} role="tab" aria-selected={t === type} onClick={() => setType(t)} className={cn("h-8 rounded-md px-3 text-[13.5px] font-medium", t === type ? "bg-paper shadow-card ring-1 ring-rule" : "text-ink-2 hover:text-ink")}>
                {LABEL_TYPE_NAMES[t]}
              </button>
            ))}
          </div>
          <label className="ms-auto flex items-center gap-2 text-[13px] text-muted">
            גודל מדבקה
            <Select value={stock} onChange={(e) => setStock(e.target.value)} aria-label="גודל מדבקה" className="w-auto">
              {STOCKS.map((s) => (
                <option key={s} value={s}>
                  {s.replace("x", "×")} מ״מ
                </option>
              ))}
            </Select>
          </label>
        </div>

        {!draft ? (
          <p className="py-6 text-center text-[13px] text-muted">טוען…</p>
        ) : (
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <div className="space-y-3.5">
              <fieldset className="text-[13px]">
                <legend className="mb-1">גופן התוויות (לכל סוגי התוויות)</legend>
                <div className="grid grid-cols-3 gap-1.5">
                  {FONT_STYLES.map((f) => (
                    <label key={f} className={cn("cursor-pointer rounded-md border px-2.5 py-2 text-center transition-colors", draft.fontStyle === f ? "border-ink bg-stone-2 ring-1 ring-ink" : "border-rule hover:bg-stone-2")}>
                      <input type="radio" name="label-font" value={f} checked={draft.fontStyle === f} onChange={() => set({ fontStyle: f })} className="sr-only" />
                      <span className="block font-medium">{FONT_STYLE_NAMES[f].name}</span>
                      <span className="block text-[11.5px] text-muted">{FONT_STYLE_NAMES[f].sub}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {type === "BOOK" && (
                <label className="block text-[13px]">
                  <span className="mb-1 block">שם לדוגמה בתצוגה</span>
                  <Select value={sample} onChange={(e) => setSample(Number(e.target.value))} aria-label="שם לדוגמה בתצוגה">
                    {BOOK_SAMPLES.map((s, i) => (
                      <option key={s} value={i}>
                        {s}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              <Slider label={type === "BOOK" ? "גודל שם הספר" : type === "LOCATION" ? "גודל שם המדף" : "גודל שם העמודה"} value={draft.titleSizeMm} min={2.5} max={14} step={0.5} onChange={(v) => set({ titleSizeMm: v })} />
              <label className="block text-[13px]">
                <span className="mb-1 block">מיקום השם</span>
                <Select value={draft.titleAlign} onChange={(e) => set({ titleAlign: e.target.value as LabelProfile["titleAlign"] })} aria-label="מיקום השם">
                  <option value="center">במרכז</option>
                  <option value="right">מיושר לימין</option>
                  <option value="left">מיושר לשמאל</option>
                </Select>
              </label>
              <Slider label="גובה הברקוד" value={draft.barcodeHeightMm} min={5} max={24} step={0.5} onChange={(v) => set({ barcodeHeightMm: v })} />
              {type === "BOOK" && <Slider label="גודל המספר המודפס" value={draft.numberSizeMm} min={2.4} max={8} step={0.2} onChange={(v) => set({ numberSizeMm: v })} />}
              {type === "BOOK" && (
                <label className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" checked={draft.showLogo} onChange={(e) => set({ showLogo: e.target.checked })} className="size-4 accent-[var(--color-ink)]" />
                  הצג את לוגו אבות ליד שם הספר
                </label>
              )}
              <Slider label="שוליים" value={draft.marginMm} min={1} max={6} step={0.5} onChange={(v) => set({ marginMm: v })} />
              <Slider label="מרווח בין האזורים" value={draft.gapMm} min={0.4} max={5} step={0.2} onChange={(v) => set({ gapMm: v })} />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-center rounded-lg bg-stone p-4" data-testid="label-preview">
                {previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewUrl} alt={`תצוגה מקדימה: ${LABEL_TYPE_NAMES[type]}`} className="max-h-72 w-full object-contain shadow-card ring-1 ring-rule" style={{ imageRendering: "pixelated" }} />
                ) : (
                  <span className="text-[13px] text-muted">מכין תצוגה…</span>
                )}
              </div>
              {info && (
                <p className={cn("text-[12.5px]", info.barcodeFits ? "text-muted" : "rounded-md bg-warn-soft px-3 py-2 text-warn")} data-testid="label-info">
                  {info.widthMm}×{info.heightMm} מ״מ · ברקוד {info.barcodeWidthMm} מ״מ ברוחב, קו {info.barcodeModuleMm} מ״מ
                  {info.barcodeFits ? "" : " — הקוד ארוך מדי למדבקה הזו, הסריקה עלולה להיות פחות אמינה. בחרו מדבקה רחבה יותר."}
                </p>
              )}
              <p className="text-[12px] text-muted">התצוגה מחושבת באותו מנוע שמדפיס (ZPL ודרייבר Windows), ברזולוציית המדפסת ({dotsPerMm === 12 ? "300" : "203"} dpi).</p>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2 border-t border-rule pt-4">
          <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => void save()}>
            שמירה
          </Button>
          <Button disabled={busy || !printerId} onClick={() => void testPrint()} title={printerId ? undefined : "לא הוגדרה מדפסת"}>
            {dirty ? "שמירה והדפסת ניסיון" : "הדפסת ניסיון"}
          </Button>
          <Button variant="ghost" disabled={busy || (!current?.customised && !dirty)} onClick={() => (current?.customised ? void reset() : setDraft(DEFAULT_LABEL_PROFILES[type]))}>
            חזרה לברירת מחדל
          </Button>
        </div>
      </div>
    </Panel>
  );
}
