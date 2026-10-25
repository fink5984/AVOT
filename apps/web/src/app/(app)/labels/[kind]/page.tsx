import { notFound } from "next/navigation";
import QRCode from "qrcode";
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
  qr?: string;
}

interface Label {
  key: string;
  code: string;
  /** big line */
  head: string;
  /** small lines */
  lines: string[];
  qr: string | null;
}

/**
 * Print-ready tags: on a thermal roll (one label per page at the label's
 * size) or on an A4 sheet. "Print → Save as PDF" gives the PDF; the ZPL
 * button gives the same tags for Zebra-compatible thermal printers.
 * Book tags go on the sleeve / box / a hanging tag — never on an antique binding.
 */
export default async function LabelsPage({ params, searchParams }: { params: Promise<{ kind: string }>; searchParams: Promise<Search> }) {
  const user = await requirePageUser("label.print");
  const { kind } = await params;
  if (!["books", "locations", "commands"].includes(kind)) notFound();
  const sp = await searchParams;
  const ids = (sp.ids ?? "").split(",").filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 1000);
  const sizeKey = LABEL_SIZES[sp.size ?? ""] ? sp.size! : kind === "commands" ? "100x50" : kind === "locations" ? "70x40" : "50x25";
  const size = labelSize(sizeKey);
  const layout = sp.layout === "sheet" ? "sheet" : "roll";
  const withQr = sp.qr === "1";

  let labels: Label[] = [];
  if (kind === "books") {
    const books = await bookLabels(user.organizationId, ids);
    labels = await Promise.all(
      books.map(async (b) => ({
        key: b.id,
        code: b.code,
        head: b.code,
        lines: [b.title, ...(b.subtitle ? [b.subtitle] : [])],
        qr: withQr ? await QRCode.toString(b.code, { type: "svg", margin: 0, errorCorrectionLevel: "M" }) : null,
      })),
    );
  } else if (kind === "locations") {
    const locs = await locationLabels(user.organizationId, ids);
    labels = locs.map((l) => ({ key: l.id, code: l.code, head: l.code, lines: [l.label], qr: null }));
  } else {
    labels = (Object.keys(COMMAND_CODES) as CommandCode[]).map((c) => ({ key: c, code: c, head: `מצב ${t.scanMode[COMMAND_CODES[c]]}`, lines: [c, "מחליף את מצב המסופון בלבד — ההרשאות נבדקות בשרת"], qr: null }));
  }

  const w = size.widthMm;
  const h = size.heightMm;
  const barH = kind === "books" ? h * 0.42 : h * 0.45;
  const zplHref = kind === "commands" ? null : `/api/labels/zpl?${kind === "books" ? "items" : "locations"}=${ids.join(",")}&size=${sizeKey}`;

  return (
    <div className="bg-white">
      <LabelsToolbar kind={kind as "books" | "locations" | "commands"} count={labels.length} size={sizeKey} sizes={Object.keys(LABEL_SIZES)} layout={layout} qr={withQr} ids={sp.ids ?? ""} zplHref={zplHref} />
      <style>{layout === "roll" ? `@page { size: ${w}mm ${h}mm; margin: 0; } @media print { .label { border: 0 !important; margin: 0 !important; } .labels { display: block !important; padding: 0 !important; } }` : `@page { size: A4; margin: 8mm; } @media print { .labels { padding: 0 !important; } .label { border-color: transparent !important; } }`}</style>
      <div className={layout === "roll" ? "labels flex flex-wrap gap-3 p-4" : "labels mx-auto flex w-[194mm] flex-wrap content-start gap-0 p-4"}>
        {labels.map((l) => (
          <div
            key={l.key}
            className="label flex shrink-0 flex-col overflow-hidden border border-dashed border-rule bg-white text-black"
            style={{ width: `${w}mm`, height: `${h}mm`, padding: "1.6mm 2mm", breakAfter: layout === "roll" ? "page" : undefined, breakInside: "avoid" }}
          >
            <div className="flex min-h-0 flex-1 gap-[2mm]">
              <div className="min-w-0 flex-1">
                <div className="[&>svg]:h-full [&>svg]:w-full" style={{ height: `${barH}mm` }} dangerouslySetInnerHTML={{ __html: code128Svg(l.code) }} />
                <div dir="ltr" className="num mt-[0.6mm] text-center font-mono font-bold leading-none" style={{ fontSize: `${Math.min(h * 0.16, kind === "books" ? 3.6 : 5.5)}mm` }}>
                  {kind === "commands" ? l.lines[0] : l.code}
                </div>
              </div>
              {l.qr && <div className="shrink-0 [&>svg]:h-full [&>svg]:w-auto" style={{ height: `${h * 0.55}mm` }} dangerouslySetInnerHTML={{ __html: l.qr }} />}
            </div>
            <div className="mt-[0.8mm] truncate font-semibold leading-tight" style={{ fontSize: `${Math.min(h * 0.11, kind === "commands" ? 5 : 3)}mm` }}>
              {kind === "commands" ? l.head : l.lines[0]}
            </div>
            {kind === "commands" && <div className="truncate leading-tight text-[#555]" style={{ fontSize: "2.4mm" }}>{l.lines[1]}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
