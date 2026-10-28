import { requirePageUser } from "@/server/auth/principal";
import { env } from "@/server/env";
import { listPrintJobs, listPrinters } from "@/server/services/printing";
import { PrinterAdmin } from "./printer-client";

export const metadata = { title: "מדפסת תוויות" };

export default async function PrinterSettingsPage() {
  const admin = await requirePageUser("print.manage");
  const [{ printers, agents, queue }, jobs] = await Promise.all([listPrinters(admin.organizationId), listPrintJobs(admin.organizationId, { limit: 30 })]);
  return (
    <PrinterAdmin
      serverUrl={env().APP_URL}
      printers={printers.map((p) => ({
        id: p.id,
        name: p.name,
        model: p.model,
        connection: p.connection,
        host: p.host,
        port: p.port,
        windowsName: p.windowsName,
        labelSize: p.labelSize,
        dotsPerMm: p.dotsPerMm,
        language: p.language,
        isPrimary: p.isPrimary,
        active: p.active,
        agentId: p.agentId,
        lastStatus: p.lastStatus,
        lastStatusAt: p.lastStatusAt?.toISOString() ?? null,
        lastError: p.lastError,
        agentOnline: p.agentOnline,
        agentName: p.agentName,
      }))}
      queue={queue}
      agents={agents}
      jobs={jobs}
    />
  );
}
