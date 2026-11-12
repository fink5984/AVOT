"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Badge, type Tone } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api";
import { formatUsd } from "@/lib/money";
import { FIELD_LABEL, RESULT_FIELDS, type ImportMapping, type ResultField } from "@/lib/sale-fields";
import type { ImportSummary, RowResult } from "@/server/services/sale-import";

type Upload = { importId: string; headers: string[]; buyersHeaders: string[] | null; mapping: ImportMapping; rowsInFile: number; previouslyImported: boolean };
type Preview = { rows: RowResult[]; summary: ImportSummary };

const ACTION: Record<string, { label: string; tone: Tone }> = {
  CREATE: { label: "יקלט", tone: "green" },
  UPDATE: { label: "יתעדכן", tone: "info" },
  UNCHANGED: { label: "ללא שינוי", tone: "neutral" },
  CONFLICT: { label: "התנגשות", tone: "danger" },
  SKIP: { label: "לא ייקלט", tone: "warn" },
  ERROR: { label: "שגיאה", tone: "danger" },
};
const MATCH: Record<string, string> = { EXISTING: "לקוח קיים", NEW: "לקוח חדש", NEEDS_DETAILS: "חסרים פרטים", AMBIGUOUS: "לא חד-משמעי", NONE: "" };

/**
 * "ייבוא תוצאות מכירה": 1) choose the file(s)  2) check the detected columns  3) preview exactly what will happen  4) commit.
 * Nothing is written before the last click, and a lot missing from the file is never treated as unsold.
 */
export function SaleImportDialog({ open, onClose, catalogId, templates }: { open: boolean; onClose: () => void; catalogId: string; templates: { id: string; name: string }[] }) {
  const router = useRouter();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [buyers, setBuyers] = useState<File | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [up, setUp] = useState<Upload | null>(null);
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  const [pv, setPv] = useState<Preview | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [tplName, setTplName] = useState("");

  function reset() {
    setFile(null);
    setBuyers(null);
    setUp(null);
    setMapping(null);
    setPv(null);
    setFilter("");
  }
  const close = () => {
    reset();
    onClose();
  };

  async function upload() {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      if (buyers) form.set("buyers", buyers);
      if (templateId) form.set("templateId", templateId);
      const res = await fetch(`/api/catalogs/${catalogId}/sale-import`, { method: "POST", body: form, credentials: "same-origin" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "העלאת הקובץ נכשלה");
      setUp(data);
      setMapping(data.mapping);
      await preview(data.importId, data.mapping);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function preview(importId: string, m: ImportMapping) {
    setBusy(true);
    try {
      setPv(await api<Preview>(`/api/sale-imports/${importId}`, { method: "POST", json: { action: "preview", mapping: m } }));
    } catch (err) {
      setPv(null);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!up) return;
    setBusy(true);
    try {
      const r = await api<Preview>(`/api/sale-imports/${up.importId}`, { method: "POST", json: { action: "commit" } });
      toast.success(`הייבוא נקלט: ${r.summary.created} רכישות חדשות, ${r.summary.updated} עודכנו`, { detail: r.summary.conflicts ? `${r.summary.conflicts} שורות בהתנגשות לא שונו` : undefined });
      close();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveTemplate() {
    if (!up || !mapping || !tplName.trim()) return;
    try {
      await api(`/api/sale-imports/${up.importId}`, { method: "POST", json: { action: "saveTemplate", mapping, templateName: tplName.trim() } });
      toast.success("תבנית המיפוי נשמרה");
      setTplName("");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const set = (f: ResultField, header: string) => {
    if (!mapping) return;
    const results = { ...mapping.results };
    if (header) results[f] = header;
    else delete results[f];
    setMapping({ ...mapping, results });
    setPv(null);
  };
  const s = pv?.summary;
  const shown = (pv?.rows ?? []).filter((r) => !filter || r.action === filter);

  return (
    <Dialog
      open={open}
      onClose={close}
      width="xl"
      title="ייבוא תוצאות מכירה"
      description="קובץ Excel או CSV של תוצאות המכירה. הקובץ אינו חייב להיות בפורמט קבוע: מוצגת התאמת העמודות שזוהתה, וניתן לתקן אותה. שום דבר לא נשמר לפני אישור."
      footer={
        pv ? (
          <>
            <Button onClick={close}>ביטול</Button>
            <Button variant="primary" loading={busy} disabled={!s || s.created + s.updated === 0} onClick={commit}>
              אישור וקליטה ({s ? s.created + s.updated : 0} שינויים)
            </Button>
          </>
        ) : undefined
      }
    >
      {!up ? (
        <div className="space-y-4">
          <label className="block text-[13.5px]">
            <span className="mb-1 block font-medium">קובץ תוצאות (XLSX או CSV)</span>
            <input type="file" accept=".xlsx,.csv,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="קובץ תוצאות" />
          </label>
          <label className="block text-[13.5px]">
            <span className="mb-1 block font-medium">קובץ קונים נפרד (לא חובה)</span>
            <input type="file" accept=".xlsx,.csv,.txt" onChange={(e) => setBuyers(e.target.files?.[0] ?? null)} aria-label="קובץ קונים" />
            <span className="mt-1 block text-[12px] text-muted">אם פרטי הקונים נמצאים בקובץ אחר, הוא יקושר לשורות התוצאות לפי מספר מציע או מזהה קונה.</span>
          </label>
          {templates.length > 0 && (
            <label className="block text-[13.5px]">
              <span className="mb-1 block font-medium">תבנית מיפוי שמורה</span>
              <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="w-64" aria-label="תבנית מיפוי">
                <option value="">זיהוי אוטומטי</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <Button variant="primary" loading={busy} disabled={!file} onClick={upload}>
            העלאה ובדיקה
          </Button>
        </div>
      ) : (
        <div className="space-y-5">
          {up.previouslyImported && <p className="rounded-md bg-info-soft px-3 py-2 text-[13px] text-info">קובץ זהה כבר נקלט בעבר. קליטה חוזרת לא תיצור רכישות או לקוחות כפולים.</p>}
          <details open={!pv}>
            <summary className="cursor-pointer text-[13.5px] font-medium">התאמת עמודות ({up.rowsInFile} שורות בקובץ)</summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {RESULT_FIELDS.map((f) => (
                <label key={f} className="flex items-center gap-2 text-[13px]">
                  <span className="w-36 shrink-0 text-ink-2">{FIELD_LABEL[f]}</span>
                  <Select value={mapping?.results[f] ?? ""} onChange={(e) => set(f, e.target.value)} aria-label={FIELD_LABEL[f]} className="flex-1">
                    <option value="">לא קיים בקובץ</option>
                    {up.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </Select>
                </label>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" loading={busy} onClick={() => mapping && preview(up.importId, mapping)}>
                בדיקה מחדש
              </Button>
              <Input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="שם לתבנית" className="w-40" aria-label="שם תבנית" />
              <Button size="sm" disabled={!tplName.trim()} onClick={saveTemplate}>
                שמירת המיפוי כתבנית
              </Button>
            </div>
          </details>

          {s && (
            <>
              <div className="grid grid-cols-2 gap-2 text-[13px] sm:grid-cols-4" data-testid="import-summary">
                <Tile k="לוטים בקובץ" v={s.rowsInFile} />
                <Tile k="נמכרו" v={s.sold} />
                <Tile k="לא נמכרו" v={s.unsold} />
                <Tile k="ללא תוצאה בקובץ" v={s.unknown} />
                <Tile k="קונים" v={s.buyers} />
                <Tile k="לקוחות חדשים" v={s.newCustomers} />
                <Tile k="לקוחות קיימים" v={s.existingCustomers} />
                <Tile k="דורשים השלמת פרטים" v={s.needsDetails} />
                <Tile k="סכום פטיש" v={formatUsd(s.hammerTotal, "$0")} />
                <Tile k="לא זוהו / שגיאות" v={s.errors} warn={s.errors > 0} />
                <Tile k="התנגשויות עם נתונים קיימים" v={s.conflicts} warn={s.conflicts > 0} />
                <Tile k="לוטים שאינם בקובץ" v={s.lotsNotInFile} sub="לא ישונו" />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                סינון שורות:
                <Select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="סינון שורות" className="w-44">
                  <option value="">הכול ({pv!.rows.length})</option>
                  {Object.entries(ACTION).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="max-h-80 overflow-auto rounded-lg border border-rule">
                <table className="w-full text-[12.5px]">
                  <thead className="sticky top-0 bg-stone-2 text-muted">
                    <tr>
                      <th className="px-2 py-2 text-start font-medium">שורה</th>
                      <th className="px-2 py-2 text-start font-medium">לוט</th>
                      <th className="px-2 py-2 text-start font-medium">תוצאה</th>
                      <th className="px-2 py-2 text-start font-medium">פטיש</th>
                      <th className="px-2 py-2 text-start font-medium">קונה</th>
                      <th className="px-2 py-2 text-start font-medium">פעולה</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rule">
                    {shown.slice(0, 500).map((r) => (
                      <tr key={r.rowIndex} className="align-top">
                        <td className="num px-2 py-1.5">{r.rowIndex}</td>
                        <td className="num px-2 py-1.5">{r.lotNumber ?? "—"}</td>
                        <td className="px-2 py-1.5">{r.outcome === "SOLD" ? "נמכר" : r.outcome === "UNSOLD" ? "לא נמכר" : "לא ידוע"}</td>
                        <td className="num px-2 py-1.5">{formatUsd(r.hammerPrice, "—")}</td>
                        <td className="px-2 py-1.5">
                          {r.buyerLabel ?? "—"} <span className="text-muted">{MATCH[r.customerMatch]}</span>
                        </td>
                        <td className="px-2 py-1.5">
                          <Badge tone={ACTION[r.action]!.tone}>{ACTION[r.action]!.label}</Badge>
                          {r.messages.map((m) => (
                            <div key={m} className="mt-0.5 text-[11.5px] text-muted">
                              {m}
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[12px] text-muted">קובץ שמכיל רק את הלוטים שנמכרו אינו אומר שהשאר לא נמכרו: לוטים שאינם בקובץ נשארים כפי שהם.</p>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

function Tile({ k, v, warn, sub }: { k: string; v: React.ReactNode; warn?: boolean; sub?: string }) {
  return (
    <div className="rounded-lg bg-stone-2 px-3 py-2">
      <div className="text-[11.5px] text-muted">{k}</div>
      <div className={`num text-[17px] font-semibold ${warn ? "text-danger" : ""}`}>{v}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}
