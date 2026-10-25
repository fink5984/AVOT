import { authenticateUser } from "@/server/auth/principal";
import { contentDisposition, route } from "@/server/http";
import { bookLabels, labelSize, locationLabels, toZpl } from "@/server/services/labels";

const ids = (v: string | null) => (v ?? "").split(",").filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 1000);

/** ZPL II for thermal label printers: `?items=<id,…>&locations=<id,…>&size=50x25`. */
export const GET = route(async (req) => {
  const user = await authenticateUser(req, "label.print");
  const p = new URL(req.url).searchParams;
  const [books, locations] = await Promise.all([bookLabels(user.organizationId, ids(p.get("items"))), locationLabels(user.organizationId, ids(p.get("locations")))]);
  const body = toZpl({ books, locations, size: labelSize(p.get("size")), font: p.get("font") ?? undefined });
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": contentDisposition(`labels-${books.length + locations.length}.zpl`, true), "cache-control": "no-store" },
  });
});
