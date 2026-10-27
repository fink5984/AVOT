"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api";
import { fmt } from "@/i18n";

interface BookPreview {
  deletable: { id: string; inventoryNumber: string; title: string }[];
  blocked: { id: string; inventoryNumber: string; title: string; reason: string }[];
  photos: number;
  files: number;
  catalogAssignments: number;
  soldAssignments: number;
}
interface CatalogPreview {
  catalogs: { id: string; number: string; name: string; house: string; lots: number; activeLots: number; sold: number; offered: number }[];
  totalLots: number;
  soldLots: number;
  openPickTasks: number;
}
interface Status {
  total: number;
  deleted: number;
  remaining: number;
  inProgress: boolean;
  status: string;
  error: string | null;
}

/**
 * One confirmation for an irreversible deletion: what will be removed, what is refused and why, then a
 * progress bar driven by the server job. Closing the window does not stop the job.
 */
export function DeleteDialog({
  kind,
  ids,
  open,
  onClose,
  onDone,
}: {
  kind: "books" | "catalogs";
  ids: string[];
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [preview, setPreview] = useState<BookPreview | CatalogPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<{ id: string; status: Status | null } | null>(null);
  const finished = useRef(false);
  const base = kind === "books" ? "/api/inventory/delete" : "/api/catalogs/delete";
  const idsKey = ids.join(",");

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setError(null);
    setJob(null);
    setBusy(false);
    finished.current = false;
    api<BookPreview | CatalogPreview>(`${base}/preview`, { method: "POST", json: { ids } })
      .then(setPreview)
      .catch((e) => setError(errorMessage(e)));
  }, [open, base, idsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // follow the server job until every record and file is gone
  useEffect(() => {
    if (!job || finished.current) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await api<Status>(`/api/deletions/${job.id}`);
        if (stop) return;
        setJob({ id: job.id, status: s });
        if (!s.inProgress && !finished.current) {
          finished.current = true;
          if (s.remaining === 0) {
            toast.success(kind === "books" ? `${s.total} ספרים נמחקו לצמיתות` : `${s.total} קטלוגים נמחקו`);
            onDone?.();
            onClose();
          } else {
            setError(s.error ?? "המחיקה לא הושלמה. המערכת תמשיך לנסות ברקע.");
          }
          router.refresh();
          return;
        }
      } catch {
        /* transient network error: try again */
      }
      if (!stop) setTimeout(tick, 1200);
    };
    const t = setTimeout(tick, 600);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [job?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ jobId: string }>(base, { method: "POST", json: { ids: kind === "books" ? (preview as BookPreview).deletable.map((d) => d.id) : ids } });
      setJob({ id: r.jobId, status: null });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const books = kind === "books" ? (preview as BookPreview | null) : null;
  const cats = kind === "catalogs" ? (preview as CatalogPreview | null) : null;
  const count = books ? books.deletable.length : ids.length;
  const running = !!job;
  const progress = job?.status ? job.status.deleted : 0;
  const total = job?.status?.total ?? count;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={kind === "books" ? `מחיקת ${count} ספרים לצמיתות` : `מחיקת ${ids.length === 1 ? "הקטלוג" : `${ids.length} קטלוגים`} לצמיתות`}
      width="md"
    >
      {!preview && !error && <p className="py-6 text-center text-[13px] text-muted">בודק מה יימחק…</p>}
      {preview && !running && (
        <div className="space-y-3 text-[13.5px]">
          {books && (
            <>
              <p>
                יימחקו <b className="num">{books.deletable.length}</b> ספרים, <b className="num">{fmt.num(books.photos)}</b> תמונות ו-<b className="num">{fmt.num(books.files)}</b> קבצי מקור (כולל קבצי RAW, תצוגות מקדימות וקטנות) מהאחסון.
              </p>
              {books.catalogAssignments > 0 && (
                <p className="text-ink-2">
                  הספרים יוסרו גם מ-<span className="num">{books.catalogAssignments}</span> שיוכים לקטלוגים
                  {books.soldAssignments > 0 && (
                    <>
                      {" "}
                      (מתוכם <span className="num">{books.soldAssignments}</span> שסומנו כנמכרו)
                    </>
                  )}
                  .
                </p>
              )}
              {books.blocked.length > 0 && (
                <div className="rounded-md bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
                  <div className="font-medium">{books.blocked.length} ספרים לא יימחקו:</div>
                  <ul className="mt-1 max-h-24 list-disc space-y-0.5 overflow-y-auto ps-5">
                    {books.blocked.map((b) => (
                      <li key={b.id}>
                        <span className="num">{b.inventoryNumber}</span> {b.title} — {b.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
          {cats && (
            <>
              <ul className="max-h-40 divide-y divide-rule overflow-y-auto rounded-md border border-rule">
                {cats.catalogs.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 px-3 py-1.5">
                    <span className="font-medium">
                      {c.house} · קטלוג <span className="num">{c.number}</span>
                    </span>
                    <span className="truncate text-muted">{c.name}</span>
                    <span className="num ms-auto text-[12.5px] text-muted">{c.lots} פריטים</span>
                  </li>
                ))}
              </ul>
              <p>
                יימחקו הקטלוג, <b className="num">{cats.totalLots}</b> שיוכי הפריטים שבו והתיאורים הייחודיים לו. <b>הספרים והתמונות נשארים במלאי.</b>
              </p>
              {cats.soldLots > 0 && <p className="text-[12.5px] text-ink-2">{cats.soldLots} פריטים סומנו כנמכרו: הספר נשאר בסטטוס "נמכר", ורק רשומת הקטלוג נמחקת.</p>}
              {cats.openPickTasks > 0 && <p className="text-[12.5px] text-ink-2">{cats.openPickTasks} משימות ליקוט פתוחות ימשיכו להתקיים.</p>}
            </>
          )}
          <p className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>הפעולה בלתי הפיכה — אין שחזור מסל המחזור.</span>
          </p>
        </div>
      )}
      {running && (
        <div className="space-y-3 py-2">
          <Progress value={progress} max={total} tone="accent" className="h-2" />
          <p className="text-[13px] text-muted">
            המחיקה בתהליך · <span className="num">{progress}</span> מתוך <span className="num">{total}</span>
            {job?.status && !job.status.inProgress && job.status.remaining > 0 ? " · נכשל חלקית, ממשיכים לנסות ברקע" : ""}
          </p>
          <p className="text-[12.5px] text-faint">אפשר לסגור את החלון — המחיקה ממשיכה בשרת.</p>
        </div>
      )}
      {error && (
        <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
          {error}
        </p>
      )}
      <div className="mt-5 flex gap-2">
        {!running && (
          <Button variant="danger" loading={busy} disabled={!preview || count === 0} onClick={confirm}>
            מחיקה לצמיתות
          </Button>
        )}
        <Button onClick={onClose}>{running ? "סגירה" : "ביטול"}</Button>
      </div>
    </Dialog>
  );
}
