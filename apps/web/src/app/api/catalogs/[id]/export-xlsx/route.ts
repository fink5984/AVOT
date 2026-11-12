import { authenticateUser } from "@/server/auth/principal";
import { contentDisposition, route } from "@/server/http";
import { buildCatalogWorkbook } from "@/server/services/catalog-xlsx";

/** The whole catalog (never the table's filter) as an Excel file; missing prices are reported in headers, not blocked. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "export.create");
  const { id } = await params;
  const f = await buildCatalogWorkbook(user, id, new URL(req.url).searchParams.get("profile") ?? undefined);
  return new Response(new Uint8Array(f.buffer), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": contentDisposition(f.filename),
      "cache-control": "no-store",
      "x-avot-lots": String(f.lots),
      "x-avot-missing-prices": String(f.missingPrices),
    },
  });
});
