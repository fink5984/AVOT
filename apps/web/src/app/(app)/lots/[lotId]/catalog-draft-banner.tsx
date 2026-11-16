"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDownToLine, ArrowUpFromLine, CheckCircle2, FileDiff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormattedText } from "@/components/ui/rich-text";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api";
import type { Segment } from "@/lib/rich-text";

/*
 * Where the lot's catalog text and its book's draft stand. An ordinary lot's headline / description are the book's catalog
 * draft (edited in the panel below, saved to the book, followed by the lot). When a text was written ON PURPOSE for this
 * catalog it differs from the draft and is never overwritten by it: this banner says so, shows both, and offers the two
 * explicit actions (each versioned and audited, each refused if either side changed meanwhile). Nothing is joined silently.
 */
export function CatalogDraftBanner({
  lotId,
  synced,
  open,
  canLot,
  canBook,
  itemVersion,
  lotVersion,
  lot,
  book,
}: {
  lotId: string;
  synced: boolean;
  /** the lot may still be changed (assignment active, catalog not archived, not offered / sold) */
  open: boolean;
  canLot: boolean;
  canBook: boolean;
  itemVersion: number;
  lotVersion: number;
  lot: { headline: string | null; description: Segment[] };
  book: { headline: string | null; description: Segment[] };
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function resolve(direction: "book_to_lot" | "lot_to_book") {
    const msg =
      direction === "book_to_lot"
        ? "להחליף את הכותרת והתיאור של הלוט בטיוטת הספר?\nהנוסח הנוכחי של הלוט נשמר בהיסטוריית הגרסאות שלו."
        : "להעביר את הכותרת והתיאור של הלוט לטיוטת הספר?\nהטיוטה הקיימת של הספר תוחלף (השינוי נרשם בהיסטוריית הספר ויחייב בדיקה מחדש).";
    if (!window.confirm(msg)) return;
    setBusy(direction);
    try {
      await api(`/api/lots/${lotId}/catalog-draft`, { method: "POST", json: { direction, expectedItemVersion: itemVersion, expectedLotVersion: lotVersion } });
      toast.success(direction === "book_to_lot" ? "הלוט עודכן לפי טיוטת הספר" : "טיוטת הספר עודכנה לפי הלוט");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (synced) {
    return (
      <p className="flex items-center gap-2 px-1 text-[12.5px] text-muted" data-testid="catalog-draft-synced">
        <CheckCircle2 className="size-4 shrink-0 text-green" aria-hidden />
        הכותרת והתיאור הקטלוגיים מסונכרנים עם הספר: עריכה כאן מופיעה גם בדף הספר במלאי, ולהפך.
      </p>
    );
  }
  return (
    <section className="rounded-lg border border-info/30 bg-info-soft/60 px-4 py-3.5 text-[13px]" aria-label="תוכן ייעודי לקטלוג" data-testid="catalog-draft-diverged">
      <h2 className="flex items-center gap-2 text-[14px] font-semibold text-ink">
        <FileDiff className="size-4 text-info" aria-hidden />
        בלוט זה יש כותרת או תיאור ייעודיים לקטלוג
      </h2>
      <p className="mt-1 leading-relaxed text-ink-2">
        הנוסח שמוצג בקטלוג שונה מטיוטת הספר. עריכת הטיוטה (בפאנל למטה ובדף הספר במלאי) לא משנה את הלוט כל עוד הנוסחים שונים, כדי לא לדרוס עבודה שנעשתה במיוחד לקטלוג.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="min-w-0 rounded-md bg-paper px-3 py-2.5 ring-1 ring-rule">
          <div className="text-[12px] font-medium text-muted">מוצג בקטלוג (נוסח הלוט)</div>
          {lot.headline && <div className="mt-1 font-semibold text-ink">{lot.headline}</div>}
          <FormattedText segments={lot.description} className="mt-1 line-clamp-6 whitespace-pre-line leading-relaxed text-ink-2" />
        </div>
        <div className="min-w-0 rounded-md bg-paper px-3 py-2.5 ring-1 ring-rule">
          <div className="text-[12px] font-medium text-muted">טיוטת הספר (במלאי)</div>
          {book.headline && <div className="mt-1 font-semibold text-ink">{book.headline}</div>}
          <FormattedText segments={book.description} className="mt-1 line-clamp-6 whitespace-pre-line leading-relaxed text-ink-2" />
        </div>
      </div>
      {open && canLot ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" icon={<ArrowDownToLine />} loading={busy === "book_to_lot"} disabled={!!busy} onClick={() => void resolve("book_to_lot")}>
            החלת טיוטת הספר על הלוט
          </Button>
          {canBook && (
            <Button size="sm" icon={<ArrowUpFromLine />} loading={busy === "lot_to_book"} disabled={!!busy} onClick={() => void resolve("lot_to_book")}>
              העברת נוסח הלוט לטיוטת הספר
            </Button>
          )}
        </div>
      ) : (
        <p className="mt-2 text-[12px] text-muted">{open ? "אין לך הרשאה להכריע בין הנוסחים." : "הלוט כבר הוצע או נמכר, או שהקטלוג בארכיון: נוסח הלוט אינו משתנה."}</p>
      )}
    </section>
  );
}
