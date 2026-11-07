import Papa from "papaparse";
import { authenticateUser } from "@/server/auth/principal";
import { contentDisposition, json, route } from "@/server/http";
import { listRunsForReport } from "@/server/services/ai-analysis";

/**
 * Every AI run of the organization with provider, model, tokens, cost, time and what the reviewer had to change -
 * for comparing providers after the fact. ?format=csv downloads it (opens in Excel); ?from / ?to (YYYY-MM-DD) filter.
 */
export const GET = route(async (req) => {
  const user = await authenticateUser(req, "report.view");
  const url = new URL(req.url);
  const day = (k: string, end = false) => {
    const v = url.searchParams.get(k);
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T${end ? "23:59:59.999" : "00:00:00"}Z`) : undefined;
  };
  const rows = await listRunsForReport(user.organizationId, { from: day("from"), to: day("to", true) });
  if (url.searchParams.get("format") !== "csv") return json({ runs: rows });
  // BOM so Excel reads the Hebrew titles as UTF-8
  const csv = "﻿" + Papa.unparse(rows);
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": contentDisposition("ai-runs.csv"), "cache-control": "no-store" } });
});
