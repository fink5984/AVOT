"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Download } from "lucide-react";
import type { PhotoCategory } from "@avot/shared";
import { Button, ButtonLink } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input } from "@/components/ui/field";
import { Progress } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { fmt } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import type { JobDto } from "@/server/services/job-dto";

export type ExportScope =
  | { scope: "catalog"; catalogId: string }
  | { scope: "lot"; lotId: string }
  | { scope: "category"; lotId: string; category: PhotoCategory }
  | { scope: "selection"; assetIds: string[] };

/**
 * Starts a background ZIP export and follows its progress. Large exports are
 * built server-side by the job worker — never inside a request that can time out.
 */
export function ExportDialog({ open, onClose, request, title }: { open: boolean; onClose: () => void; request: ExportScope; title: string }) {
  const toast = useToast();
  const [variant, setVariant] = useState<"original" | "catalog-jpeg">("original");
  const [maxSize, setMaxSize] = useState(3000);
  const [includeRaw, setIncludeRaw] = useState(true);
  const [readable, setReadable] = useState(false);
  const [job, setJob] = useState<JobDto | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) setJob(null);
  }, [open]);

  useEffect(() => {
    if (!job || job.status === "SUCCEEDED" || job.status === "FAILED") return;
    const id = setInterval(async () => {
      try {
        const r = await api<{ job: JobDto }>(`/api/exports/${job.id}`);
        setJob(r.job);
      } catch {
        /* keep polling */
      }
    }, 1200);
    return () => clearInterval(id);
  }, [job]);

  async function start() {
    setBusy(true);
    try {
      const r = await api<{ job: JobDto }>("/api/exports", {
        method: "POST",
        json: { ...request, variant, maxSize, includeRaw, readableFolders: readable },
      });
      setJob(r.job);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={title} description="הקובץ נבנה ברקע. אפשר לסגור את החלון — הוא יחכה במסך ההורדות.">
      {!job ? (
        <div className="space-y-4">
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="mb-2 text-[13px] font-medium text-ink-2">איכות</legend>
            {(
              [
                ["original", "קבצי מקור", "באיכות מלאה, כפי שצולמו."],
                ["catalog-jpeg", "JPEG לקטלוג", "מוקטן לצלע ארוכה מוגדרת, איכות 90."],
              ] as const
            ).map(([v, title, sub]) => (
              <label
                key={v}
                className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3.5 py-3 text-[13.5px] transition-colors ${variant === v ? "border-ink bg-stone-2 ring-1 ring-ink" : "border-rule hover:bg-stone-2"}`}
              >
                <input type="radio" name="variant" checked={variant === v} onChange={() => setVariant(v)} className="mt-1 accent-[var(--color-ink)]" />
                <span>
                  <span className="font-medium">{title}</span>
                  <span className="mt-0.5 block text-[12.5px] text-muted">{sub}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {variant === "catalog-jpeg" && (
            <Field label="צלע ארוכה (פיקסלים)">
              {(p) => <Input {...p} type="number" min={400} max={12000} step={100} value={maxSize} onChange={(e) => setMaxSize(Number(e.target.value))} className="num w-32 text-start" />}
            </Field>
          )}
          {variant === "original" && <Checkbox label="לכלול קובצי RAW (אם צולמו)" checked={includeRaw} onChange={(e) => setIncludeRaw(e.target.checked)} />}
          <Checkbox label="שמות תיקיות קריאים (מספר + שם הספר)" checked={readable} onChange={(e) => setReadable(e.target.checked)} />
          <div className="flex gap-2 pt-2">
            <Button variant="primary" loading={busy} onClick={start} icon={<Download />}>
              יצירת קובץ ZIP
            </Button>
            <Button onClick={onClose}>ביטול</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {job.status === "FAILED" ? (
            <p className="rounded-md bg-danger-soft px-3 py-2.5 text-[13px] text-danger">הייצוא נכשל: {job.error}</p>
          ) : job.status === "SUCCEEDED" ? (
            <>
              <p className="text-[13px]">
                הקובץ מוכן: <span className="font-medium" dir="ltr">{job.resultName}</span> ({fmt.bytes(job.resultBytes)})
              </p>
              <p className="text-[12px] text-muted">הקישור זמין עד {fmt.dateTime(job.expiresAt)}.</p>
              <ButtonLink href={`/api/exports/${job.id}/download`} variant="primary" icon={<Download />} prefetch={false}>
                הורדה
              </ButtonLink>
            </>
          ) : (
            <>
              <p className="text-[13px] text-ink-2">
                {job.status === "QUEUED" ? "ממתין בתור…" : "בונה את הקובץ…"}{" "}
                {job.progressTotal > 0 && (
                  <span className="num">
                    {job.progress}/{job.progressTotal}
                  </span>
                )}
              </p>
              <Progress value={job.progress} max={job.progressTotal || 1} tone="accent" />
            </>
          )}
          <p className="text-[12px] text-muted">
            כל ההורדות שהוכנו:{" "}
            <Link href="/exports" className="font-medium text-ink underline underline-offset-2">
              מסך ההורדות
            </Link>
          </p>
        </div>
      )}
    </Dialog>
  );
}
