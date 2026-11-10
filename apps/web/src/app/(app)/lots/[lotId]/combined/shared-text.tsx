"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Package, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Panel } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api";

/**
 * The head of a combined lot: main photo, shared title, consignor (derived from the books), number of books and the
 * shared catalog description. The text lives on the LOT only - it is never copied into the books.
 */
export function SharedTextCard({
  lotId,
  title,
  shortDescription,
  description,
  mainAssetId,
  bookCount,
  consignor,
  canViewConsignor,
  canEdit,
}: {
  lotId: string;
  title: string;
  shortDescription: string | null;
  description: string | null;
  mainAssetId: string | null;
  bookCount: number;
  consignor: { id: string; name: string } | null;
  canViewConsignor: boolean;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Panel
      title="תיאור הלוט"
      actions={
        canEdit && (
          <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setOpen(true)}>
            עריכת כותרת ותיאור
          </Button>
        )
      }
    >
      <div className="flex flex-wrap gap-4 p-4 sm:flex-nowrap">
        <span className="block aspect-[4/3] w-full shrink-0 overflow-hidden rounded-lg bg-stone ring-1 ring-rule sm:w-44">
          {mainAssetId ? <img src={`/api/assets/${mainAssetId}/thumb`} alt="התמונה הראשית של הלוט" className="size-full object-contain" /> : <Package className="m-auto mt-10 size-8 text-faint" aria-hidden />}
        </span>
        <div className="min-w-0 flex-1 space-y-2 text-[13.5px]">
          <h2 className="text-[16px] font-semibold leading-snug">{title}</h2>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted">
            <span>
              <span className="num font-semibold text-ink">{bookCount}</span> ספרים בלוט
            </span>
            <span>
              מפקיד:{" "}
              {consignor ? (
                canViewConsignor ? (
                  <Link href={`/consignors/${consignor.id}`} className="font-medium text-ink-2 hover:underline">
                    {consignor.name}
                  </Link>
                ) : (
                  <span className="font-medium text-ink-2">{consignor.name}</span>
                )
              ) : (
                "לא מוגדר"
              )}
            </span>
          </p>
          {shortDescription && <p className="whitespace-pre-line leading-relaxed text-ink-2">{shortDescription}</p>}
          {description ? (
            <p className="whitespace-pre-line leading-relaxed">{description}</p>
          ) : (
            <p className="text-muted">עדיין אין תיאור קטלוגי משותף. אפשר לכתוב אותו ידנית או ליצור אותו ב-AI.</p>
          )}
        </div>
      </div>
      {open && <SharedTextDialog lotId={lotId} initial={{ title, shortDescription: shortDescription ?? "", description: description ?? "" }} onClose={() => setOpen(false)} />}
    </Panel>
  );
}

function SharedTextDialog({ lotId, initial, onClose }: { lotId: string; initial: { title: string; shortDescription: string; description: string }; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => setV(initial), [initial]);

  async function save() {
    setBusy(true);
    try {
      await api(`/api/lots/${lotId}`, { method: "PATCH", json: { title: v.title.trim(), shortDescription: v.shortDescription.trim() || null, description: v.description.trim() || null } });
      toast.success("הכותרת והתיאור המשותפים נשמרו", { detail: "כל שינוי נשמר בהיסטוריית הלוט." });
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="כותרת ותיאור משותפים" description="הטקסט נשמר ברשומת הלוט בלבד ואינו מועתק לספרים." width="lg">
      <div className="space-y-4">
        <Field label="כותרת משותפת" required>{(p) => <Input {...p} value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} maxLength={300} />}</Field>
        <Field label="תקציר">{(p) => <Textarea {...p} value={v.shortDescription} onChange={(e) => setV({ ...v, shortDescription: e.target.value })} rows={2} maxLength={2000} />}</Field>
        <Field label="תיאור קטלוגי משותף">{(p) => <Textarea {...p} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} rows={12} maxLength={20000} className="leading-relaxed" />}</Field>
      </div>
      <div className="mt-6 flex gap-2">
        <Button variant="primary" loading={busy} disabled={!v.title.trim()} onClick={save}>
          שמירה
        </Button>
        <Button onClick={onClose}>ביטול</Button>
      </div>
    </Dialog>
  );
}
