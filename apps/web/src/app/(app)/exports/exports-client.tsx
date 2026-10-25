"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Progress } from "@/components/ui/misc";
import { fmt, t } from "@/i18n";
import { api } from "@/lib/api";
import type { JobDto } from "@/server/services/job-dto";

const STATUS: Record<string, { label: string; tone: "neutral" | "green" | "danger" | "info" | "accent" }> = {
  QUEUED: { label: "בתור", tone: "neutral" },
  RUNNING: { label: "בעבודה", tone: "info" },
  SUCCEEDED: { label: "מוכן", tone: "green" },
  FAILED: { label: "נכשל", tone: "danger" },
  CANCELLED: { label: "בוטל", tone: "neutral" },
};

export function ExportsTable({
  initial,
  lots,
  catalogs,
}: {
  initial: JobDto[];
  lots: { id: string; lotNumber: number; title: string }[];
  catalogs: { id: string; number: string; name: string }[];
}) {
  const [jobs, setJobs] = useState(initial);
  const active = jobs.some((j) => j.status === "QUEUED" || j.status === "RUNNING");

  useEffect(() => {
    if (!active) return;
    const id = setInterval(async () => {
      try {
        const r = await api<{ jobs: JobDto[] }>("/api/exports");
        setJobs(r.jobs);
      } catch {
        /* retry next tick */
      }
    }, 2000);
    return () => clearInterval(id);
  }, [active]);

  const describe = (j: JobDto) => {
    const p = j.payload as { scope: string; lotId?: string; catalogId?: string; category?: keyof typeof t.category; assetIds?: string[]; variant?: string };
    const lot = lots.find((l) => l.id === p.lotId);
    const cat = catalogs.find((c) => c.id === p.catalogId);
    const scope =
      p.scope === "catalog"
        ? `קטלוג ${cat?.number ?? ""} · ${cat?.name ?? ""}`
        : p.scope === "lot"
          ? `פריט ${lot?.lotNumber ?? ""} · ${lot?.title ?? ""}`
          : p.scope === "category"
            ? `פריט ${lot?.lotNumber ?? ""} · ${p.category ? t.category[p.category] : ""}`
            : `${p.assetIds?.length ?? 0} תמונות נבחרות`;
    return { scope, variant: p.variant === "catalog-jpeg" ? "JPEG לקטלוג" : "מקור מלא" };
  };

  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[720px] text-[13.5px]">
        <thead>
          <tr className="border-b border-rule text-[12.5px] text-muted">
            <th className="px-5 py-3 text-start font-medium">היקף</th>
            <th className="w-28 px-3 py-3 text-start font-medium">איכות</th>
            <th className="w-44 px-3 py-3 text-start font-medium">מצב</th>
            <th className="w-24 px-3 py-3 text-start font-medium">גודל</th>
            <th className="w-32 px-3 py-3 text-start font-medium">נוצר</th>
            <th className="w-28 px-3 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {jobs.map((j) => {
            const d = describe(j);
            const s = STATUS[j.status] ?? STATUS.QUEUED!;
            return (
              <tr key={j.id}>
                <td className="px-5 py-3">
                  <div className="font-medium">{d.scope}</div>
                  {j.resultName && (
                    <div className="text-[11.5px] text-muted" dir="ltr">
                      {j.resultName}
                    </div>
                  )}
                  {j.error && <div className="text-[12px] text-danger">{j.error}</div>}
                </td>
                <td className="px-3 py-2.5 text-muted">{d.variant}</td>
                <td className="px-3 py-2.5">
                  <Badge tone={s.tone}>{s.label}</Badge>
                  {j.status === "RUNNING" && j.progressTotal > 0 && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <Progress value={j.progress} max={j.progressTotal} tone="accent" className="w-24" />
                      <span className="num text-[11.5px] text-muted">
                        {j.progress}/{j.progressTotal}
                      </span>
                    </div>
                  )}
                </td>
                <td className="num px-3 py-2.5 text-start text-muted">{fmt.bytes(j.resultBytes)}</td>
                <td className="px-3 py-2.5 text-muted" title={fmt.dateTime(j.createdAt)}>
                  {fmt.relative(j.createdAt)}
                </td>
                <td className="px-3 py-2.5">
                  {j.downloadable ? (
                    <ButtonLink href={`/api/exports/${j.id}/download`} size="sm" variant="primary">
                      הורדה
                    </ButtonLink>
                  ) : j.status === "SUCCEEDED" ? (
                    <span className="text-[12px] text-faint">פג תוקף</span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
