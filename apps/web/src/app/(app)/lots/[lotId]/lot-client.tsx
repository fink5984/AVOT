"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Check, History, MoreHorizontal, Pencil, Printer } from "lucide-react";
import type { LotStatus } from "@avot/shared";
import { Button, IconButton } from "@/components/ui/button";
import { LOT_TONE, toneDot } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/field";
import { Menu } from "@/components/ui/menu";
import { Panel } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { LotFormDialog, type LotFormValue } from "@/components/lot-form-dialog";
import { t } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";

const STEPS: LotStatus[] = ["IN_PROGRESS", "PENDING_REVIEW", "NEEDS_RESHOOT", "COMPLETED"];

/** Work status as one segmented control — a single click changes it. */
export function LotControls({
  lotId,
  status,
  unmet,
  nextLotId,
  canStatus,
}: {
  lotId: string;
  status: LotStatus;
  unmet: string[];
  nextLotId: string | null;
  canStatus: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<LotStatus | null>(null);

  async function setStatus(next: LotStatus) {
    if (next === status) return;
    if (next === "COMPLETED" && unmet.length && !window.confirm(`חסרות תמונות בקטגוריות: ${unmet.join(", ")}.\nלסמן את הפריט כהושלם בכל זאת?`)) return;
    setBusy(next);
    try {
      await api(`/api/lots/${lotId}`, { method: "PATCH", json: { status: next } });
      toast.success(`הפריט סומן: ${t.lotStatus[next]}`, nextLotId && next === "COMPLETED" ? { action: { label: "לפריט הבא", onClick: () => router.push(`/lots/${nextLotId}`) } } : undefined);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (!canStatus) return null;
  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
      <div role="radiogroup" aria-label="מצב עבודה" className="flex flex-wrap rounded-lg bg-stone p-0.5">
        {STEPS.map((s) => {
          const active = status === s;
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={!!busy}
              onClick={() => setStatus(s)}
              className={cn(
                "flex h-8 items-center gap-2 rounded-md px-3 text-[13px] transition-colors disabled:opacity-60",
                active ? "bg-paper font-semibold text-ink shadow-card" : "text-muted hover:text-ink",
              )}
            >
              {s === "COMPLETED" && active ? (
                <Check className="size-3.5 text-green" strokeWidth={3} />
              ) : (
                <span className={cn("size-1.5 rounded-full", active || busy === s ? toneDot(LOT_TONE[s]) : "bg-faint/60")} aria-hidden />
              )}
              {t.lotStatus[s]}
            </button>
          );
        })}
      </div>
      {unmet.length > 0 ? (
        <span className="flex items-center gap-1.5 text-[13px] text-warn">
          <AlertCircle className="size-4" />
          חסר: {unmet.join(", ")}
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-[13px] text-green">
          <Check className="size-4" />
          כל דרישות הצילום מולאו
        </span>
      )}
    </div>
  );
}

export function LotMenu({ lot, catalogId, canEdit, canAudit }: { lot: LotFormValue; catalogId: string; canEdit: boolean; canAudit: boolean }) {
  const router = useRouter();
  const [edit, setEdit] = useState(false);
  return (
    <>
      <Menu
        trigger={(p) => (
          <IconButton label="פעולות נוספות" variant="secondary" {...p}>
            <MoreHorizontal />
          </IconButton>
        )}
        items={[
          ...(canEdit ? [{ label: "עריכת פרטי הספר", icon: <Pencil />, onSelect: () => setEdit(true) }] : []),
          { label: "הדפסת תווית", icon: <Printer />, onSelect: () => router.push(`/catalogs/${catalogId}/labels?lot=${lot.id}`) },
          ...(canAudit ? [{ label: "היסטוריית פעולות", icon: <History />, onSelect: () => router.push(`/settings/audit?lot=${lot.id}`) }] : []),
        ]}
      />
      {edit && <LotFormDialog open onClose={() => setEdit(false)} catalogId={catalogId} initial={lot} />}
    </>
  );
}

export function LotDetails({ lot, catalogId, canEdit }: { lot: LotFormValue; catalogId: string; canEdit: boolean }) {
  const [edit, setEdit] = useState(false);
  const rows = [
    ["מחבר", lot.author],
    ["מקום דפוס", lot.printPlace],
    ["שנת דפוס", lot.printYear],
    ["כותרת משנה", lot.subtitle],
  ].filter((r): r is [string, string] => !!r[1]);
  return (
    <Panel
      title="פרטי הספר"
      actions={
        canEdit && (
          <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEdit(true)}>
            עריכה
          </Button>
        )
      }
    >
      <div className="space-y-3 px-5 py-4 text-[13.5px]">
        {rows.length === 0 && !lot.shortDescription ? (
          <p className="text-muted">{canEdit ? "עדיין לא הוזנו פרטים — מחבר, מקום ושנת דפוס, תיאור." : "לא הוזנו פרטים."}</p>
        ) : (
          <>
            {rows.length > 0 && (
              <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5">
                {rows.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted">{k}</dt>
                    <dd className="min-w-0 break-words">{v}</dd>
                  </div>
                ))}
              </dl>
            )}
            {lot.shortDescription && <p className="whitespace-pre-line leading-relaxed text-ink-2">{lot.shortDescription}</p>}
          </>
        )}
      </div>
      {edit && <LotFormDialog open onClose={() => setEdit(false)} catalogId={catalogId} initial={lot} />}
    </Panel>
  );
}

/** Autosaved internal notes. "נשמר" appears only after the server confirmed the write. */
export function LotNotes({ lotId, initial, canEdit }: { lotId: string; initial: string; canEdit: boolean }) {
  const [value, setValue] = useState(initial);
  const [state, setState] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  const saved = useRef(initial);

  useEffect(() => {
    if (value === saved.current) return;
    setState("dirty");
    const id = setTimeout(async () => {
      setState("saving");
      try {
        await api(`/api/lots/${lotId}`, { method: "PATCH", json: { internalNotes: value } });
        saved.current = value;
        setState("saved");
      } catch {
        setState("error");
      }
    }, 900);
    return () => clearTimeout(id);
  }, [value, lotId]);

  const label = { idle: "", dirty: "לא נשמר עדיין", saving: "שומר…", saved: "נשמר", error: "השמירה נכשלה — ינסה שוב בשינוי הבא" }[state];

  return (
    <Panel
      title="הערות פנימיות"
      actions={
        <span className={cn("text-[12px]", state === "error" ? "text-danger" : state === "saved" ? "text-green" : "text-faint")} role="status">
          {label}
        </span>
      }
    >
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        readOnly={!canEdit}
        rows={4}
        placeholder={canEdit ? "מצב הספר, פגמים, דפים חסרים…" : "אין הערות"}
        className="rounded-none border-0 bg-transparent px-5 py-3.5 shadow-none focus:ring-0"
        aria-label="הערות פנימיות"
      />
    </Panel>
  );
}
