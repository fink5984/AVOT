import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { queryHostStatus, sendTcp, sendWindowsRaw, stateOf } from "./transport.mjs";

export const AGENT_VERSION = "1.0.0";
const API_VERSION = 1;

export function defaultConfigDir() {
  if (process.env.AVOT_PRINT_AGENT_HOME) return process.env.AVOT_PRINT_AGENT_HOME;
  if (process.platform === "win32") return path.join(process.env.ProgramData ?? path.join(homedir(), "AppData", "Local"), "AvotPrintAgent");
  return path.join(homedir(), ".avot-print-agent");
}

/** Atomic JSON write: a power cut never leaves a half-written token or journal. */
async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, file);
}
async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export class PrintAgent {
  constructor({ dir = defaultConfigDir(), log = console, fetchImpl = fetch, transports = {} } = {}) {
    this.dir = dir;
    this.log = log;
    this.fetch = fetchImpl;
    this.t = { tcp: sendTcp, windows: sendWindowsRaw, status: queryHostStatus, ...transports };
    this.configFile = path.join(dir, "config.json");
    this.journalFile = path.join(dir, "journal.json");
    this.config = null;
    this.stopped = false;
    this.printers = [];
  }

  async load() {
    this.config = await readJson(this.configFile, null);
    return this.config;
  }

  /** One-time pairing with the 8-digit code from Settings → Label printer. */
  async pair({ server, code, name }) {
    const res = await this.fetch(new URL("/api/agent/pair", server), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: name ?? "סוכן הדפסה", machineName: hostname(), agentVersion: AGENT_VERSION, apiVersion: API_VERSION }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error?.message ?? `הצימוד נכשל (${res.status})`);
    this.config = { server: new URL(server).origin, token: body.deviceToken, deviceId: body.deviceId, name: body.name };
    await writeJson(this.configFile, this.config);
    return this.config;
  }

  async api(pathname, body) {
    const res = await this.fetch(new URL(pathname, this.config.server), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.config.token}` },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 401) throw Object.assign(new Error("הסוכן אינו מורשה — צריך לבצע צימוד מחדש"), { fatal: true });
    if (!res.ok) throw new Error(data?.error?.message ?? `שגיאת שרת (${res.status})`);
    return data;
  }

  /* The journal is what prevents a second print after a crash or restart. */
  async journal() {
    return readJson(this.journalFile, {});
  }
  async mark(jobId, state) {
    const j = await this.journal();
    j[jobId] = { state, at: new Date().toISOString() };
    // keep the file small: only the last 500 jobs matter
    const keys = Object.keys(j);
    if (keys.length > 500) for (const k of keys.sort((a, b) => j[a].at.localeCompare(j[b].at)).slice(0, keys.length - 500)) delete j[k];
    await writeJson(this.journalFile, j);
  }

  async deliver(job) {
    const p = job.printer;
    if (job.format === "GDI" || !job.zpl) throw new Error("מצב ״דרייבר Windows״ נתמך רק ב-AVOT Capture Desktop. בחרו מצב ZPL או הדפיסו דרך עמדת הצילום.");
    if (p.connection === "NETWORK") return this.t.tcp({ host: p.host, port: p.port, data: job.zpl });
    if (p.connection === "WINDOWS") return this.t.windows({ printerName: p.windowsName, data: job.zpl });
    throw new Error(`סוג חיבור לא נתמך: ${p.connection}`);
  }

  /** After the bytes were written: if the printer can say its buffer is empty, the labels are out. */
  async confirm(job) {
    const p = job.printer;
    if (p.connection !== "NETWORK") return "SENT";
    const deadline = Date.now() + 20_000;
    let seenAnswer = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1200));
      const st = await this.t.status({ host: p.host, port: p.port });
      if (!st) return seenAnswer ? "SENT" : "SENT";
      seenAnswer = true;
      if (st.paperOut || st.headUp) return "SENT";
      if (st.formatsInBuffer === 0 && st.labelsRemaining === 0 && !st.labelWaiting) return "DONE";
    }
    return "SENT";
  }

  async report(jobId, status, error) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.api(`/api/print/agent/jobs/${jobId}/report`, { status, error: error ?? null });
      } catch (err) {
        if (err.fatal) throw err;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    this.log.error?.(`לא הצלחתי לדווח על משימה ${jobId} (${status})`);
  }

  /** Handles one claimed job end to end. Never prints the same job twice. */
  async process(job) {
    const j = (await this.journal())[job.jobId];
    if (j?.state === "sent") {
      // already written to the printer by an earlier run of this agent: only the report was missing
      this.log.info?.(`משימה ${job.jobId} כבר נשלחה בעבר — מדווח בלבד`);
      return this.report(job.jobId, "SENT");
    }
    if (j?.state === "sending") {
      // crashed in the middle of sending: the label may or may not have printed — never guess
      return this.report(job.jobId, "FAILED", "הסוכן הופסק באמצע ההדפסה. בדקו אם התווית יצאה והדפיסו מחדש במידת הצורך.");
    }
    await this.mark(job.jobId, "sending");
    try {
      await this.deliver(job);
    } catch (err) {
      await this.mark(job.jobId, "failed");
      this.log.error?.(`הדפסה נכשלה: ${err.message}`);
      return this.report(job.jobId, "FAILED", err.message);
    }
    await this.mark(job.jobId, "sent");
    await this.report(job.jobId, "SENT");
    const final = await this.confirm(job);
    if (final === "DONE") await this.report(job.jobId, "DONE");
  }

  async pollOnce() {
    const { job } = await this.api("/api/print/agent/claim");
    if (!job) return false;
    await this.process(job);
    return true;
  }

  async heartbeat() {
    const hello = await this.api("/api/print/agent/heartbeat", { agentVersion: AGENT_VERSION, machineName: hostname(), printers: await this.collectStates() });
    this.printers = hello.printers ?? [];
    return hello;
  }

  async collectStates() {
    const out = [];
    for (const p of this.printers) {
      if (p.connection !== "NETWORK") {
        out.push({ printerId: p.id, state: "OK", detail: null });
        continue;
      }
      const st = await this.t.status({ host: p.host, port: p.port }).catch(() => null);
      if (!st) {
        // no ~HS answer: either off, or a model that does not report. A plain connect tells them apart.
        const reachable = await this.t.tcp({ host: p.host, port: p.port, data: "" }).then(() => true).catch(() => false);
        out.push({ printerId: p.id, state: reachable ? "OK" : "OFFLINE", detail: reachable ? null : "המדפסת לא מגיבה" });
      } else out.push({ printerId: p.id, ...stateOf(st) });
    }
    return out;
  }

  async run() {
    if (!this.config) throw new Error("הסוכן אינו מצומד. הריצו: avot-print-agent pair --server <כתובת האתר> --code <קוד>");
    let lastBeat = 0;
    let idle = 0;
    while (!this.stopped) {
      try {
        if (Date.now() - lastBeat > 15_000) {
          await this.heartbeat();
          lastBeat = Date.now();
        }
        const worked = await this.pollOnce();
        idle = worked ? 0 : Math.min(idle + 1, 5);
      } catch (err) {
        if (err.fatal) {
          this.log.error?.(err.message);
          throw err;
        }
        this.log.warn?.(`אין חיבור לשרת: ${err.message}`);
        idle = 5;
      }
      await new Promise((r) => setTimeout(r, idle === 0 ? 100 : 1000 + idle * 400));
    }
  }

  stop() {
    this.stopped = true;
  }
}
