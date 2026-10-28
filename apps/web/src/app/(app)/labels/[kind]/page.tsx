import { notFound } from "next/navigation";
import { COMMAND_CODES, type CommandCode } from "@avot/shared";
import { requirePageUser } from "@/server/auth/principal";
import { LABEL_SIZES, bookLabels, labelSize, locationLabels } from "@/server/services/labels";
import { code128Svg } from "@/lib/barcode/code128";
import { t } from "@/i18n";
import { LabelsToolbar } from "./labels-toolbar";

export const metadata = { title: "הדפסת תוויות" };

interface Search {
  ids?: string;
  size?: string;
  layout?: "roll" | "sheet";
}

/**
 * Manual print / PDF / ZPL of book and shelf labels. The labels are NOT designed here: each one is the PNG of the one
 * label engine (the same layout, text and barcode as the printer's, with the saved calibration), shown at the physical
 * size. Normal printing is one click on the printer icon (central queue) — this page is the fallback for paper / PDF.
 * The scanner command cards at the bottom of the kinds are not book / shelf / column labels and keep their own sheet.
 */
export default async function LabelsPage({ params, searchParams }: { params: Promise<{ kind: string }>; searchParams: Promise<Search> }) {
  const user = await requirePageUser("label.print");
  const { kind } = await params;
  if (!["books", "locations", "commands"].includes(kind)) notFound();
  const sp = await searchParams;
  const ids = (sp.ids ?? "").split(",").filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 1000);
  const sizeKey = LABEL_SIZES[sp.size ?? ""] ? sp.size! : kind === "commands" ? "100x50" : "57x32";
  const size = labelSize(sizeKey);
  const layout = sp.layout === "sheet" ? "sheet" : "roll";

  let keys: string[] = [];
  let commandCards: { code: string; head: string; note: string }[] = [];
  if (kind === "books") keys = (await bookLabels(user.organizationId, ids)).map((b) => b.id);
  else if (kind === "locations") keys = (await locationLabels(user.organizationId, ids)).map((l) => l.id);
  else commandCards = (Object.keys(COMMAND_CODES) as CommandCode[]).map((c) => ({ code: c, head: `מצב ${t.scanMode[COMMAND_CODES[c]]}`, note: "מחליף את מצב המסופון בלבד — ההרשאות נבדקות בשרת" }));

  const w = size.widthMm;
  const h = size.heightMm;
  const count = kind === "commands" ? commandCards.length : keys.length;
  const zplHref = kind === "commands" ? null : `/api/labels/zpl?${kind === "books" ? "items" : "locations"}=${ids.join(",")}&size=${sizeKey}`;
  const type = kind === "books" ? "BOOK" : "LOCATION";

  return (
    <div className="bg-white">
      <LabelsToolbar kind={kind as "books" | "locations" | "commands"} count={count} size={sizeKey} sizes={Object.keys(LABEL_SIZES)} layout={layout} ids={sp.ids ?? ""} zplHref={zplHref} />
      <style>{layout === "roll" ? `@page { size: ${w}mm ${h}mm; margin: 0; } @media print { .label { border: 0 !important; margin: 0 !important; } .labels { display: block !important; padding: 0 !important; } }` : `@page { size: A4; margin: 8mm; } @media print { .labels { padding: 0 !important; } .label { border-color: transparent !important; } }`}</style>
      <div className={layout === "roll" ? "labels flex flex-wrap gap-3 p-4" : "labels mx-auto flex w-[194mm] flex-wrap content-start gap-0 p-4"}>
        {kind !== "commands" &&
          keys.map((id) => (
            <div key={id} className="label shrink-0 overflow-hidden border border-dashed border-rule bg-white" style={{ width: `${w}mm`, height: `${h}mm`, breakAfter: layout === "roll" ? "page" : undefined, breakInside: "avoid" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/labels/png?type=${type}&id=${id}&stock=${sizeKey}`} alt="" style={{ width: `${w}mm`, height: `${h}mm`, imageRendering: "pixelated" }} />
            </div>
          ))}
        {kind === "commands" &&
          commandCards.map((c) => (
            <div key={c.code} className="label flex shrink-0 flex-col overflow-hidden border border-dashed border-rule bg-white text-black" style={{ width: `${w}mm`, height: `${h}mm`, padding: "1.6mm 2mm", breakAfter: layout === "roll" ? "page" : undefined, breakInside: "avoid" }}>
              <div className="min-h-0 flex-1 [&>svg]:h-full [&>svg]:w-full" style={{ maxHeight: `${h * 0.45}mm` }} dangerouslySetInnerHTML={{ __html: code128Svg(c.code) }} />
              <div dir="ltr" className="num mt-[0.6mm] text-center font-mono font-bold leading-none" style={{ fontSize: `${Math.min(h * 0.16, 5.5)}mm` }}>
                {c.code}
              </div>
              <div className="mt-[0.8mm] truncate font-semibold leading-tight" style={{ fontSize: `${Math.min(h * 0.11, 5)}mm` }}>
                {c.head}
              </div>
              <div className="truncate leading-tight text-[#555]" style={{ fontSize: "2.4mm" }}>
                {c.note}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
