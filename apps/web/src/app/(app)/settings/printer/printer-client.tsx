"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Link2, Plus, Printer as PrinterIcon, RotateCcw, Star, Trash2, X } from "lucide-react";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { EmptyState, Panel } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { fmt } from "@/i18n";
import { api, errorMessage } from "@/lib/api";

export interface PrinterDto {
  id: string;
  name: string;
  model: string | null;
  connection: "NETWORK" | "WINDOWS";
  host: string | null;
  port: number;
  windowsName: string | null;
  labelSize: string;
  dotsPerMm: number;
  isPrimary: boolean;
  active: boolean;
  agentId: string | null;
  lastStatus: string | null;
  lastStatusAt: string | null;
  lastError: string | null;
  agentOnline: boolean;
  agentName: string | null;
}
export interface AgentDto {
  id: string;
  name: string;
  machineName: string | null;
  agentVersion: string | null;
  online: boolean;
  lastSeenAt: string | null;
}
export interface JobDto {
  id: string;
  kind: string;
  status: "PENDING" | "CLAIMED" | "SENT" | "DONE" | "FAILED" | "CANCELLED";
  summary: string | null;
  labelCount: number;
  attempts: number;
  error: string | null;
  printerName: string | null;
  createdBy: string | null;
  createdAt: string;
  sentAt: string | null;
  doneAt: string | null;
}

const PRINTER_STATE: Record<string, { text: string; tone: Tone }> = {
  OK: { text: "מחוברת", tone: "green" },
  OFFLINE: { text: "לא מגיבה / כבויה", tone: "danger" },
  PAPER_OUT: { text: "נגמרו המדבקות", tone: "warn" },
  HEAD_OPEN: { text: "מכסה המדפסת פתוח", tone: "warn" },
  PAUSED: { text: "המדפסת מושהית", tone: "warn" },
  ERROR: { text: "שגיאה", tone: "danger" },
};

/** What each job state means to a worker. "SENT" is deliberately not "printed". */
const JOB_STATE: Record<JobDto["status"], { text: string; tone: Tone; hint?: string }> = {
  PENDING: { text: "ממתין", tone: "neutral" },
  CLAIMED: { text: "ממתין", tone: "neutral", hint: "סוכן ההדפסה קיבל את המשימה" },
  SENT: { text: "נשלח למדפסת", tone: "info", hint: "המדפסת לא מדווחת על סיום — בדקו שהתווית יצאה" },
  DONE: { text: "הושלם", tone: "green" },
  FAILED: { text: "נכשל", tone: "danger" },
  CANCELLED: { text: "בוטל", tone: "neutral" },
};

const SIZES = ["50x25", "57x32", "70x40", "100x50"];

export function PrinterAdmin({ printers, agents, jobs, serverUrl }: { printers: PrinterDto[]; agents: AgentDto[]; jobs: JobDto[]; serverUrl: string }) {
  const router = useRouter();
  const toast = useToast();
  const [edit, setEdit] = useState<PrinterDto | "new" | null>(null);
  const [pair, setPair] = useState<{ code: string; expiresAt: string } | null | "open">(null);

  // live queue and connection state
  useEffect(() => {
    const id = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(id);
  }, [router]);

  async function act(fn: () => Promise<unknown>, ok?: string) {
    try {
      await fn();
      if (ok) toast.success(ok);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function createCode() {
    try {
      setPair(await api<{ code: string; expiresAt: string }>("/api/devices/pairing-code", { method: "POST", json: { name: "סוכן הדפסה", kind: "PRINT" } }));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="space-y-5">
      <Panel
        title="מדפסות תוויות"
        actions={
          <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setEdit("new")}>
            הוספת מדפסת
          </Button>
        }
      >
        {printers.length === 0 ? (
          <EmptyState icon={<PrinterIcon />} title="לא הוגדרה מדפסת תוויות">
            הוסיפו את המדפסת הקבועה, וחברו את סוכן ההדפסה שליד המדפסת. אחר כך כל עובד, מכל מחשב או טלפון, ידפיס בלחיצה אחת.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-rule">
            {printers.map((p) => {
              const st = p.lastStatus ? PRINTER_STATE[p.lastStatus] ?? { text: p.lastStatus, tone: "neutral" as Tone } : null;
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[14.5px] font-semibold">{p.name}</span>
                      {p.isPrimary && <Badge tone="accent">ראשית</Badge>}
                      {!p.active && <Badge>מושבתת</Badge>}
                    </div>
                    <div className="mt-0.5 text-[12.5px] text-muted">
                      {p.model && <>{p.model} · </>}
                      {p.connection === "NETWORK" ? <span className="num">{p.host}:{p.port}</span> : <>Windows: {p.windowsName}</>} · מדבקה <span className="num">{p.labelSize.replace("x", "×")}</span> מ״מ · <span className="num">{p.dotsPerMm === 12 ? 300 : 203}</span> dpi
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <Badge tone={p.agentOnline ? "green" : "danger"}>{p.agentOnline ? `סוכן הדפסה מחובר${p.agentName ? ` (${p.agentName})` : ""}` : "סוכן ההדפסה לא מחובר"}</Badge>
                      {st && <Badge tone={st.tone}>{st.text}</Badge>}
                      {p.lastStatusAt && <span className="text-[12px] text-faint">עודכן {fmt.relative(p.lastStatusAt)}</span>}
                    </div>
                    {p.lastError && p.lastStatus !== "OK" && <p className="mt-1 text-[12.5px] text-danger">{p.lastError}</p>}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button size="sm" onClick={() => act(() => api(`/api/print/printers/${p.id}/test`, { method: "POST" }), "הדפסת ניסיון נשלחה לתור")}>
                      הדפסת ניסיון
                    </Button>
                    {!p.isPrimary && p.active && (
                      <IconButton label="הגדרה כמדפסת ראשית" size="sm" onClick={() => act(() => api(`/api/print/printers/${p.id}`, { method: "PATCH", json: { isPrimary: true } }), "המדפסת הוגדרה כראשית")}>
                        <Star />
                      </IconButton>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setEdit(p)}>
                      עריכה
                    </Button>
                    <IconButton
                      label="מחיקת מדפסת"
                      size="sm"
                      onClick={() => {
                        if (window.confirm(`למחוק את המדפסת "${p.name}"?`)) void act(() => api(`/api/print/printers/${p.id}`, { method: "DELETE" }), "המדפסת נמחקה");
                      }}
                    >
                      <Trash2 />
                    </IconButton>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        title="סוכן הדפסה"
        actions={
          <Button size="sm" icon={<Link2 />} onClick={createCode}>
            צימוד סוכן חדש
          </Button>
        }
      >
        <p className="px-5 pt-3 text-[13px] leading-relaxed text-ink-2">
          סוכן ההדפסה הוא תוכנה קטנה שרצה במחשב הקבוע ליד המדפסת (Windows או Raspberry Pi). היא מתחברת החוצה לאתר, מקבלת את התוויות ושולחת אותן למדפסת — בלי לפתוח פורטים ובלי שהאתר יגיע לכתובת הפנימית של המדפסת.
        </p>
        {agents.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-muted">אין סוכן מצומד. לחצו ״צימוד סוכן חדש״ והריצו אותו לפי ההוראות.</p>
        ) : (
          <ul className="divide-y divide-rule px-0 py-2 text-[13px]">
            {agents.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-5 py-2">
                <span className={`size-2 rounded-full ${a.online ? "bg-green" : "bg-faint"}`} aria-hidden />
                <span className="font-medium">{a.name}</span>
                <span className="text-muted">{a.machineName}</span>
                <span className="num text-[12px] text-faint">v{a.agentVersion}</span>
                <span className="ms-auto text-[12px] text-muted">{a.online ? "מחובר" : a.lastSeenAt ? `נראה לאחרונה ${fmt.relative(a.lastSeenAt)}` : "לא התחבר"}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="תור הדפסות">
        {jobs.length === 0 ? (
          <p className="px-5 py-6 text-center text-[13px] text-muted">עדיין לא נשלחו הדפסות.</p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-rule text-[12.5px] text-muted">
                <th className="px-5 py-2.5 text-start font-medium">משימה</th>
                <th className="hidden px-3 py-2.5 text-start font-medium md:table-cell">תוויות</th>
                <th className="px-3 py-2.5 text-start font-medium">מצב</th>
                <th className="hidden px-3 py-2.5 text-start font-medium lg:table-cell">מי / מתי</th>
                <th className="w-px px-3 py-2.5" aria-label="פעולות" />
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {jobs.map((j) => {
                const st = JOB_STATE[j.status];
                return (
                  <tr key={j.id}>
                    <td className="max-w-0 px-5 py-2.5">
                      <div className="truncate font-medium">{j.summary ?? j.kind}</div>
                      {j.error && <div className="truncate text-[12px] text-danger">{j.error}</div>}
                      {st.hint && <div className="truncate text-[12px] text-muted">{st.hint}</div>}
                    </td>
                    <td className="num hidden px-3 py-2.5 md:table-cell">{j.labelCount}</td>
                    <td className="px-3 py-2.5">
                      <Badge tone={st.tone}>{st.text}</Badge>
                      {j.attempts > 1 && <span className="num ms-1.5 text-[12px] text-muted">ניסיון {j.attempts}</span>}
                    </td>
                    <td className="hidden px-3 py-2.5 text-[12.5px] text-muted lg:table-cell">
                      {j.createdBy ?? "—"} · {fmt.relative(j.createdAt)}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex gap-0.5">
                        {(j.status === "PENDING" || j.status === "CLAIMED") && (
                          <IconButton label="ביטול" size="sm" onClick={() => act(() => api(`/api/print/jobs/${j.id}`, { method: "DELETE" }), "המשימה בוטלה")}>
                            <X />
                          </IconButton>
                        )}
                        {(j.status === "FAILED" || j.status === "SENT" || j.status === "DONE" || j.status === "CANCELLED") && (
                          <IconButton label="הדפסה מחדש" size="sm" onClick={() => act(() => api(`/api/print/jobs/${j.id}/reprint`, { method: "POST" }), "נשלחה הדפסה חוזרת")}>
                            <RotateCcw />
                          </IconButton>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      {edit && <PrinterDialog printer={edit === "new" ? null : edit} agents={agents} onClose={() => setEdit(null)} />}
      <Dialog open={!!pair} onClose={() => setPair(null)} title="צימוד סוכן הדפסה" width="md">
        {pair && pair !== "open" && (
          <div className="space-y-3 text-[13.5px]">
            <p>בסוכן ההדפסה, בחלון הצימוד או בשורת הפקודה, הזינו:</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-md bg-stone px-4 py-3">
              <dt className="text-muted">כתובת האתר</dt>
              <dd className="num font-mono" dir="ltr">{serverUrl}</dd>
              <dt className="text-muted">קוד צימוד</dt>
              <dd className="num font-mono text-[20px] font-semibold tracking-[0.15em]" dir="ltr">{pair.code}</dd>
            </dl>
            <p className="text-[12.5px] text-muted">הקוד תקף ל-15 דקות ולשימוש חד־פעמי. הפקודה: <span className="num font-mono" dir="ltr">avot-print-agent pair --server {serverUrl} --code {pair.code}</span></p>
          </div>
        )}
        <div className="mt-4">
          <Button onClick={() => setPair(null)}>סגירה</Button>
        </div>
      </Dialog>
    </div>
  );
}

function PrinterDialog({ printer, agents, onClose }: { printer: PrinterDto | null; agents: AgentDto[]; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<"NETWORK" | "WINDOWS">(printer?.connection ?? "NETWORK");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const str = (k: string) => String(f.get(k) ?? "").trim() || null;
    const body = {
      name: str("name") ?? "",
      model: str("model"),
      connection,
      host: connection === "NETWORK" ? str("host") : null,
      port: Number(str("port") ?? 9100),
      windowsName: connection === "WINDOWS" ? str("windowsName") : null,
      labelSize: str("labelSize") ?? "57x32",
      dotsPerMm: Number(str("dotsPerMm") ?? 8),
      agentId: str("agentId"),
    };
    setBusy(true);
    setError(null);
    try {
      if (printer) await api(`/api/print/printers/${printer.id}`, { method: "PATCH", json: body });
      else await api("/api/print/printers", { method: "POST", json: body });
      toast.success(printer ? "המדפסת עודכנה" : "המדפסת נוספה");
      onClose();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={printer ? "עריכת מדפסת" : "הוספת מדפסת"} width="md">
      <form onSubmit={submit} className="space-y-3.5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="שם" required>
            {(p) => <Input {...p} name="name" required defaultValue={printer?.name ?? "מדפסת תוויות"} maxLength={100} />}
          </Field>
          <Field label="דגם">{(p) => <Input {...p} name="model" defaultValue={printer?.model ?? ""} placeholder="Zebra ZD421, TSC TE210…" maxLength={100} />}</Field>
        </div>
        <Field label="חיבור">
          {(p) => (
            <Select {...p} value={connection} onChange={(e) => setConnection(e.target.value as "NETWORK" | "WINDOWS")}>
              <option value="NETWORK">מדפסת רשת (Ethernet / Wi-Fi) — מומלץ</option>
              <option value="WINDOWS">מדפסת USB במחשב Windows</option>
            </Select>
          )}
        </Field>
        {connection === "NETWORK" ? (
          <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
            <Field label="כתובת IP של המדפסת" hint="כתובת קבועה ברשת המקומית של בית המכירות">
              {(p) => <Input {...p} name="host" dir="ltr" defaultValue={printer?.host ?? ""} placeholder="192.168.1.50" className="num font-mono" />}
            </Field>
            <Field label="פורט">{(p) => <Input {...p} name="port" type="number" defaultValue={printer?.port ?? 9100} className="num" />}</Field>
          </div>
        ) : (
          <Field label="שם המדפסת ב-Windows" hint="בדיוק כפי שמופיע ב״מדפסות וסורקים״">
            {(p) => <Input {...p} name="windowsName" dir="ltr" defaultValue={printer?.windowsName ?? ""} className="font-mono" />}
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="גודל מדבקה (מ״מ)">
            {(p) => (
              <Select {...p} name="labelSize" defaultValue={printer?.labelSize ?? "57x32"}>
                {SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace("x", " × ")}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="רזולוציה">
            {(p) => (
              <Select {...p} name="dotsPerMm" defaultValue={printer?.dotsPerMm ?? 8}>
                <option value={8}>203 dpi (הנפוץ)</option>
                <option value={12}>300 dpi</option>
              </Select>
            )}
          </Field>
        </div>
        {agents.length > 1 && (
          <Field label="סוכן הדפסה" hint="ריק = כל סוכן מצומד">
            {(p) => (
              <Select {...p} name="agentId" defaultValue={printer?.agentId ?? ""}>
                <option value="">כל סוכן</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {error && (
          <p className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={busy}>
            שמירה
          </Button>
          <Button onClick={onClose}>ביטול</Button>
        </div>
      </form>
    </Dialog>
  );
}
