"use client";

import { useEffect, useState } from "react";
import { Printer } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { usePrintLabels } from "@/lib/print";

export interface PrintWatch {
  jobId: string;
  itemId: string;
  /** "ITM-… · שם" for the line */
  label: string;
}

interface JobState {
  status: "PENDING" | "CLAIMED" | "SENT" | "DONE" | "FAILED" | "CANCELLED";
  error: string | null;
  waiting: "NO_PRINTER" | "NO_AGENT" | null;
}

const TERMINAL = new Set(["DONE", "FAILED", "CANCELLED"]);

/**
 * The real state of the label queued when a book was finished. "הודפסה" is shown only when the print station
 * reported the printer finished (DONE); a label that merely sits in the queue says so, and says why it is not moving.
 */
export function LabelPrintStatus({ watch }: { watch: PrintWatch }) {
  const [job, setJob] = useState<JobState | null>(null);
  const [offline, setOffline] = useState(false);
  const print = usePrintLabels();
  const [reprinting, setReprinting] = useState(false);

  useEffect(() => {
    setJob(null);
    setOffline(false);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const tick = async () => {
      try {
        const r = await api<{ job: JobState }>(`/api/print/jobs/${watch.jobId}`);
        if (stopped) return;
        setOffline(false);
        setJob(r.job);
        // a job a printer cannot confirm stays SENT: stop asking after a minute, never claim "printed"
        const giveUp = Date.now() - started > (r.job.status === "SENT" ? 60_000 : 10 * 60_000);
        if (TERMINAL.has(r.job.status) || giveUp) return;
      } catch {
        if (stopped) return;
        setOffline(true);
      }
      timer = setTimeout(tick, 2500);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [watch.jobId]);

  let text = "בודק את מצב המדבקה…";
  let tone: "ok" | "wait" | "bad" = "wait";
  if (job) {
    switch (job.status) {
      case "PENDING":
        text = job.waiting === "NO_PRINTER" ? "המדבקה ממתינה בתור — לא הוגדרה מדפסת ראשית (הגדרות ← מדפסת תוויות)" : job.waiting === "NO_AGENT" ? "המדבקה בתור — עמדת ההדפסה אינה מחוברת כרגע, היא תודפס כשתחזור" : "המדבקה בתור ההדפסה";
        tone = job.waiting ? "bad" : "wait";
        break;
      case "CLAIMED":
        text = job.waiting === "NO_PRINTER" ? "המדבקה ממתינה — לא הוגדרה מדפסת ראשית" : "עמדת ההדפסה מטפלת במדבקה…";
        break;
      case "SENT":
        text = "המדבקה נשלחה למדפסת";
        break;
      case "DONE":
        text = "המדבקה הודפסה";
        tone = "ok";
        break;
      case "FAILED":
        text = `הדפסת המדבקה נכשלה${job.error ? ` — ${job.error}` : ""}`;
        tone = "bad";
        break;
      case "CANCELLED":
        text = "הדפסת המדבקה בוטלה";
        tone = "bad";
        break;
    }
  }

  return (
    <div className={cn("mt-3 rounded-lg px-2.5 py-2 text-[12px] leading-snug", tone === "bad" ? "bg-[#4a1d1a] text-[#f6c3bb]" : tone === "ok" ? "bg-[#17332a] text-[#9be3c0]" : "bg-studio-3 text-studio-muted")} role="status" aria-live="polite" data-testid="label-print-status">
      <div className="flex items-start gap-1.5">
        <Printer className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <div className="min-w-0">
          <div className="truncate opacity-80">{watch.label}</div>
          <div>{text}</div>
          {offline && <div className="opacity-80">אין חיבור — מצב המדבקה יתעדכן כשהחיבור יחזור</div>}
          {job && (job.status === "FAILED" || job.status === "CANCELLED") && (
            <button
              type="button"
              disabled={reprinting}
              className="mt-1 rounded bg-white/10 px-2 py-0.5 hover:bg-white/20 disabled:opacity-50"
              onClick={async () => {
                setReprinting(true);
                await print([{ type: "BOOK", id: watch.itemId }], { what: "המדבקה" });
                setReprinting(false);
              }}
            >
              הדפסה חוזרת
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
