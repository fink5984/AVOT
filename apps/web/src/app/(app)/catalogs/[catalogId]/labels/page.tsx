import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { requirePageUser } from "@/server/auth/principal";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { PrintBar } from "./print-bar";

export const metadata = { title: "תוויות פריטים" };

/**
 * Printable lot labels: lot number, short title and a QR code linking to the
 * lot (/l/<id>). Scanning with a phone or a USB scanner into the global search
 * opens the right book. Sized for 3×8 sticker sheets (A4, 70×37mm).
 */
export default async function LabelsPage({ params, searchParams }: { params: Promise<{ catalogId: string }>; searchParams: Promise<{ lot?: string; from?: string; to?: string }> }) {
  const user = await requirePageUser("catalog.view");
  const { catalogId } = await params;
  const sp = await searchParams;
  const catalog = await db.catalog.findFirst({ where: { id: catalogId, organizationId: user.organizationId } });
  if (!catalog) notFound();
  const from = sp.from ? Number(sp.from) : undefined;
  const to = sp.to ? Number(sp.to) : undefined;
  const lots = await db.lot.findMany({
    where: {
      catalogId,
      ...(sp.lot ? { id: sp.lot } : {}),
      ...(from || to ? { lotNumber: { gte: from ?? 1, lte: to ?? 99999 } } : {}),
    },
    orderBy: { lotNumber: "asc" },
    select: { id: true, lotNumber: true, title: true },
  });
  const base = env().APP_URL.replace(/\/$/, "");
  const codes = await Promise.all(lots.map((l) => QRCode.toString(`${base}/l/${l.id}`, { type: "svg", margin: 0, errorCorrectionLevel: "M" })));

  return (
    <div className="bg-white">
      <PrintBar catalogId={catalogId} count={lots.length} from={sp.from} to={sp.to} single={!!sp.lot} />
      <style>{`@page { size: A4; margin: 10mm 0 0 0; } @media print { .label-sheet { padding: 0 !important; } }`}</style>
      <div className="label-sheet mx-auto grid w-[210mm] grid-cols-3 p-4" style={{ gridAutoRows: "37mm" }}>
        {lots.map((l, i) => (
          <div key={l.id} className="flex items-center gap-[3mm] overflow-hidden border border-dashed border-rule px-[4mm] print:border-transparent" style={{ breakInside: "avoid" }}>
            <div className="size-[26mm] shrink-0 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: codes[i]! }} />
            <div className="min-w-0">
              <div className="text-[8pt] text-muted">קטלוג {catalog.number}</div>
              <div className="num text-start text-[22pt] font-bold leading-none">{l.lotNumber}</div>
              <div className="mt-[1.5mm] line-clamp-2 text-[8.5pt] leading-tight">{l.title}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
