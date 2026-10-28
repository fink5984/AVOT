"use client";

import { useRouter } from "next/navigation";
import { ArrowRight, Download, Printer, TriangleAlert } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";

const TITLE = { books: "תוויות ספרים", locations: "תוויות מיקום", commands: "ברקודי פקודה למסופון" } as const;

export function LabelsToolbar({
  kind,
  count,
  size,
  sizes,
  layout,
  ids,
  zplHref,
}: {
  kind: "books" | "locations" | "commands";
  count: number;
  size: string;
  sizes: string[];
  layout: "roll" | "sheet";
  ids: string;
  zplHref: string | null;
}) {
  const router = useRouter();
  const go = (patch: Record<string, string>) => {
    const p = new URLSearchParams({ ids, size, layout, ...patch });
    router.replace(`/labels/${kind}?${p.toString()}`);
  };
  return (
    <div className="no-print border-b border-rule px-4 py-4 lg:px-8">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => router.back()} className="flex items-center gap-1 text-[13.5px] font-medium text-muted hover:text-ink">
          <ArrowRight className="size-4" /> חזרה
        </button>
        <h1 className="text-[16px] font-semibold">{TITLE[kind]}</h1>
        <span className="text-[13.5px] text-muted">
          <span className="num font-medium text-ink">{count}</span> תוויות
        </span>
        <label className="flex items-center gap-1.5 text-[13px]">
          גודל
          <select value={size} onChange={(e) => go({ size: e.target.value })} className="h-9 rounded-md border border-rule-strong bg-paper px-2">
            {sizes.map((s) => (
              <option key={s} value={s}>
                {s.replace("x", "×")} מ״מ
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[13px]">
          פריסה
          <select value={layout} onChange={(e) => go({ layout: e.target.value })} className="h-9 rounded-md border border-rule-strong bg-paper px-2">
            <option value="roll">גליל תרמי (תווית לעמוד)</option>
            <option value="sheet">גיליון A4</option>
          </select>
        </label>
        <div className="ms-auto flex gap-2">
          {zplHref && count > 0 && (
            <ButtonLink href={zplHref} icon={<Download />} title="ZPL למדפסות תרמיות (Zebra ותואמות)">
              ZPL
            </ButtonLink>
          )}
          <Button variant="primary" icon={<Printer />} onClick={() => window.print()} disabled={count === 0}>
            הדפסה / PDF
          </Button>
        </div>
      </div>
      {kind === "books" && (
        <p className="mt-3 flex items-start gap-2 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          ספרים עתיקים: אין להדביק את התווית על הכריכה או על דפי הספר. מצמידים אותה למעטפת המגן, למארז או לתג תלוי.
        </p>
      )}
      <p className="mt-2 text-[12px] text-muted">לקובץ PDF: הדפסה ← יעד ״שמירה כ-PDF״. בהדפסה תרמית בחרו במנהל ההתקן את גודל התווית שנבחר כאן, בשוליים 0.</p>
    </div>
  );
}
