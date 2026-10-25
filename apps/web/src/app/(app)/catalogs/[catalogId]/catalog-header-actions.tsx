"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, FileDown, FileUp, MoreHorizontal, Package, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Menu } from "@/components/ui/menu";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api";
import { ExportDialog } from "@/components/export-dialog";

interface Preview {
  rows: { line: number; lotNumber?: number; title: string; author?: string }[];
  errors: { line: number; message: string }[];
  unknownColumns: string[];
  imported: number;
}

export function CatalogHeaderActions({
  catalogId,
  catalogNumber,
  canImport,
  canExport,
  canClose = false,
  activeLots = 0,
}: {
  catalogId: string;
  catalogNumber: string;
  canImport: boolean;
  canExport: boolean;
  /** end the sale event: active lots → unsold, catalog archived */
  canClose?: boolean;
  activeLots?: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  async function closeCatalog() {
    if (!window.confirm(`לסיים את קטלוג ${catalogNumber}?\n${activeLots} פריטים פעילים יסומנו "לא נמכר" (פריטים שסומנו "נמכר" נשארים). הקטלוג יעבור לארכיון והספרים יהיו זמינים לשיוך לקטלוג אחר.`)) return;
    try {
      const r = await api<{ unsold: number }>(`/api/catalogs/${catalogId}/close`, { method: "POST" });
      toast.success(`הקטלוג הסתיים · ${r.unsold} פריטים סומנו "לא נמכר"`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function onFile(file: File) {
    setFileName(file.name);
    const text = await file.text();
    setCsv(text);
    setBusy(true);
    try {
      setPreview(await api<Preview>(`/api/catalogs/${catalogId}/import?dryRun=1`, { method: "POST", body: text, headers: { "content-type": "text/csv" } }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmImport() {
    if (!csv) return;
    setBusy(true);
    try {
      const r = await api<Preview>(`/api/catalogs/${catalogId}/import`, { method: "POST", body: csv, headers: { "content-type": "text/csv" } });
      if (r.errors.length) {
        setPreview(r);
        return;
      }
      toast.success(`יובאו ${r.imported} פריטים`);
      setImportOpen(false);
      setPreview(null);
      setCsv(null);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {canExport && (
        <Button icon={<Package />} onClick={() => setExportOpen(true)}>
          הורדת תמונות
        </Button>
      )}
      <Menu
        trigger={(p) => (
          <Button {...p} icon={<MoreHorizontal />}>
            עוד
          </Button>
        )}
        items={[
          { label: "הדפסת תוויות לפריטים", icon: <Printer />, onSelect: () => router.push(`/catalogs/${catalogId}/labels`) },
          "separator",
          ...(canImport ? [{ label: "ייבוא פריטים מ-CSV", icon: <FileUp />, onSelect: () => setImportOpen(true) }] : []),
          { label: "ייצוא נתוני פריטים ל-CSV", icon: <FileDown />, onSelect: () => (window.location.href = `/api/catalogs/${catalogId}/lots-csv`) },
          ...(canClose ? (["separator", { label: "סיום הקטלוג (לא נמכרו → זמינים)", icon: <Archive />, onSelect: () => void closeCatalog() }] as const) : []),
        ]}
      />
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} request={{ scope: "catalog", catalogId }} title={`ייצוא קטלוג ${catalogNumber}`} />
      <Dialog
        open={importOpen}
        onClose={() => {
          setImportOpen(false);
          setPreview(null);
        }}
        title="ייבוא פריטים מקובץ CSV"
        width="lg"
        description="עמודות נתמכות: lot_number / מספר, title / שם ספר (חובה), subtitle / כותרת משנה, author / מחבר, print_year / שנת דפוס, print_place / מקום דפוס, short_description / תיאור, internal_notes / הערות. פריטים ללא מספר יקבלו מספור אוטומטי."
      >
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-rule-strong bg-stone-2 px-4 py-8 text-[13.5px] text-ink-2 transition-colors hover:border-ink/30 hover:bg-stone">
          <FileUp className="size-4" />
          {fileName || "בחירת קובץ CSV (UTF-8)"}
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        </label>
        {preview && (
          <div className="mt-4 space-y-3">
            <p className="text-[13px]">
              <span className="num font-semibold">{preview.rows.length}</span> שורות תקינות
              {preview.errors.length > 0 && (
                <>
                  {" · "}
                  <span className="num font-semibold text-danger">{preview.errors.length}</span> <span className="text-danger">שגיאות — הייבוא לא יבוצע עד לתיקונן</span>
                </>
              )}
            </p>
            {preview.unknownColumns.length > 0 && <p className="text-[12.5px] text-warn">עמודות שלא זוהו ולא ייובאו: {preview.unknownColumns.join(", ")}</p>}
            {preview.errors.length > 0 && (
              <ul className="max-h-32 overflow-y-auto rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
                {preview.errors.map((e, i) => (
                  <li key={i}>
                    שורה <span className="num">{e.line}</span>: {e.message}
                  </li>
                ))}
              </ul>
            )}
            <div className="max-h-56 overflow-y-auto rounded-md border border-rule">
              <table className="w-full text-[12.5px]">
                <thead className="sticky top-0 bg-stone-2">
                  <tr>
                    <th className="px-2 py-1 text-start font-medium">שורה</th>
                    <th className="px-2 py-1 text-start font-medium">מספר</th>
                    <th className="px-2 py-1 text-start font-medium">שם</th>
                    <th className="px-2 py-1 text-start font-medium">מחבר</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {preview.rows.slice(0, 200).map((r) => (
                    <tr key={r.line}>
                      <td className="num px-2 py-1 text-start text-muted">{r.line}</td>
                      <td className="num px-2 py-1 text-start">{r.lotNumber ?? "אוטומטי"}</td>
                      <td className="px-2 py-1">{r.title}</td>
                      <td className="px-2 py-1 text-muted">{r.author ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div className="mt-5 flex gap-2">
          <Button variant="primary" disabled={!preview || preview.errors.length > 0 || !preview.rows.length} loading={busy} onClick={confirmImport}>
            ייבוא {preview?.rows.length ? `${preview.rows.length} פריטים` : ""}
          </Button>
          <Button onClick={() => setImportOpen(false)}>ביטול</Button>
        </div>
      </Dialog>
    </>
  );
}
