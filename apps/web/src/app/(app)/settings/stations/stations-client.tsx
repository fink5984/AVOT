"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Link2, MonitorSmartphone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { EmptyState, Panel } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { fmt } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { probeAgent, type AgentHello } from "@/lib/capture/drivers/agent";
import { mergePrefs } from "@/lib/capture/prefs";

interface Station {
  id: string;
  name: string;
  machineName: string | null;
  online: boolean;
  lastSeenAt: string | null;
  agentVersion: string | null;
  cameraKind: string | null;
  cameraModel: string | null;
  cameraConnected: boolean;
  storagePath: string | null;
  freeDiskBytes: number | null;
  pendingUploads: number;
  failedUploads: number;
  lastSyncAt: string | null;
  lastError: string | null;
  controllingUser: string | null;
  assignedUserId: string | null;
  revoked: boolean;
}

export function StationsAdmin({ devices, users, serverUrl }: { devices: Station[]; users: { id: string; name: string }[]; serverUrl: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pairOpen, setPairOpen] = useState(false);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [repair, setRepair] = useState<Station | null>(null);
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<AgentHello | null | undefined>(undefined);

  useEffect(() => {
    void probeAgent(mergePrefs(null).agentUrl).then(setLocal);
  }, []);

  // refresh live status while the page is open
  useEffect(() => {
    const id = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(id);
  }, [router]);

  async function createCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name") ?? "");
    setBusy(true);
    try {
      const r = await api<{ code: string; expiresAt: string }>("/api/devices/pairing-code", { method: "POST", json: { name } });
      setCode(r);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function repairStation(d: Station) {
    setBusy(true);
    try {
      const r = await api<{ code: string; expiresAt: string }>("/api/devices/pairing-code", { method: "POST", json: { deviceId: d.id } });
      setRepair(d);
      setCode(r);
      setPairOpen(true);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    try {
      await api(`/api/devices/${id}`, { method: "PATCH", json: body });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function revoke(d: Station) {
    if (!window.confirm(`לבטל את העמדה "${d.name}"? היא תפסיק מיד לתקשר עם השרת. צילומים שטרם הועלו יישארו בדיסק של העמדה.`)) return;
    try {
      await api(`/api/devices/${d.id}`, { method: "DELETE" });
      toast.success("העמדה בוטלה");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <span className={local ? "size-2 rounded-full bg-green" : "size-2 rounded-full bg-faint"} aria-hidden />
          {local === undefined
            ? "בודק Capture Agent במחשב זה…"
            : local
              ? `במחשב זה פועל Capture Agent ${local.version}${local.paired ? ` (מצומד: ${local.deviceName ?? ""})` : " — לא מצומד"}${local.camera.model ? ` · ${local.camera.model}` : ""}`
              : "Capture Agent לא זוהה במחשב זה."}
        </div>
        <Button variant="primary" className="ms-auto" icon={<Link2 />} onClick={() => { setCode(null); setRepair(null); setPairOpen(true); }}>
          צימוד עמדה חדשה
        </Button>
      </div>

      <Panel>
        {devices.length === 0 ? (
          <EmptyState icon={<MonitorSmartphone />} title="אין עמדות צילום מצומדות">
            צימוד עמדה נדרש לעבודה עם מצלמת Canon דרך Capture Agent. צילום במצלמת רשת או בטלפון אינו דורש עמדה.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-[13px]">
              <thead>
                <tr className="border-b border-rule text-[12.5px] text-muted">
                  <th className="px-5 py-3 text-start font-medium">עמדה</th>
                  <th className="px-3 py-2 text-start font-medium">חיבור</th>
                  <th className="px-3 py-2 text-start font-medium">מצלמה</th>
                  <th className="px-3 py-2 text-start font-medium">משתמש מחובר</th>
                  <th className="px-3 py-2 text-start font-medium">גרסה</th>
                  <th className="px-3 py-2 text-start font-medium">אחסון מקומי</th>
                  <th className="px-3 py-2 text-start font-medium">ממתינות</th>
                  <th className="px-3 py-2 text-start font-medium">סנכרון אחרון</th>
                  <th className="px-3 py-2 text-start font-medium">שיוך</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {devices.map((d) => (
                  <tr key={d.id} className={d.revoked ? "opacity-50" : undefined}>
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{d.name}</div>
                      <div className="font-mono text-[10.5px] text-faint" dir="ltr">
                        {d.machineName} · {d.id.slice(0, 8)}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      {d.revoked ? <Badge>בוטלה</Badge> : d.online ? <Badge tone="green">מחוברת</Badge> : <Badge tone="warn">לא מחוברת</Badge>}
                      <div className="mt-0.5 text-[11.5px] text-muted">{fmt.relative(d.lastSeenAt)}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div>{d.cameraKind === "SIMULATOR" ? "סימולטור" : (d.cameraModel ?? "—")}</div>
                      <div className="text-[11.5px] text-muted">{d.cameraKind === "NONE" || !d.cameraKind ? "לא זוהתה מצלמה" : d.cameraConnected ? "USB מחובר" : "מנותקת"}</div>
                    </td>
                    <td className="px-3 py-2.5 text-muted">{d.controllingUser ?? "—"}</td>
                    <td className="num px-3 py-2.5 text-start text-muted">{d.agentVersion ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      <div className="max-w-48 truncate font-mono text-[11px] text-muted" dir="ltr" title={d.storagePath ?? undefined}>
                        {d.storagePath ?? "—"}
                      </div>
                      <div className={d.freeDiskBytes !== null && d.freeDiskBytes < 20 * 1024 ** 3 ? "text-[11.5px] text-danger" : "text-[11.5px] text-muted"}>פנוי: {fmt.bytes(d.freeDiskBytes)}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="num">{d.pendingUploads}</span>
                      {d.failedUploads > 0 && <span className="text-danger"> · {d.failedUploads} נכשלו</span>}
                      {d.lastError && (
                        <div className="max-w-44 truncate text-[11.5px] text-danger" title={d.lastError}>
                          {d.lastError}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-muted">{fmt.relative(d.lastSyncAt)}</td>
                    <td className="px-3 py-2.5">
                      <Select className="h-7.5 w-36" value={d.assignedUserId ?? ""} disabled={d.revoked} onChange={(e) => patch(d.id, { assignedUserId: e.target.value || null })} aria-label="שיוך עמדה למשתמש">
                        <option value="">כל הארגון</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex gap-1.5">
                        <Button size="sm" loading={busy} onClick={() => repairStation(d)} title="קוד צימוד חדש לעמדה זו, בלי להוסיף עמדה נוספת">
                          צימוד מחדש
                        </Button>
                        {!d.revoked && (
                          <Button size="sm" variant="danger" onClick={() => revoke(d)}>
                            ביטול
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Dialog open={pairOpen} onClose={() => setPairOpen(false)} title={repair ? `צימוד מחדש: ${repair.name}` : "צימוד עמדת צילום"} width="sm">
        {!code ? (
          <form onSubmit={createCode} className="space-y-3">
            <Field label="שם העמדה" hint="למשל: עמדת צילום 1 — חדר הספרייה">
              {(p) => <Input {...p} name="name" required maxLength={100} autoFocus />}
            </Field>
            <Button type="submit" variant="primary" loading={busy}>
              יצירת קוד צימוד
            </Button>
          </form>
        ) : (
          <div className="space-y-3 text-[13px]">
            <p>בתוכנת Capture Agent במחשב הצילום, פתחו ״צימוד לשרת״ והזינו:</p>
            <dl className="space-y-3 rounded-lg bg-stone-2 px-4 py-3.5 ring-1 ring-rule">
              <div>
                <dt className="text-[11.5px] text-muted">כתובת השרת</dt>
                <dd className="font-mono" dir="ltr">
                  {serverUrl}
                </dd>
              </div>
              <div>
                <dt className="text-[11.5px] text-muted">קוד צימוד</dt>
                <dd className="num font-mono text-[26px] font-semibold tracking-[0.2em]">
                  {code.code.slice(0, 4)} {code.code.slice(4)}
                </dd>
              </div>
            </dl>
            <p className="text-[12px] text-muted">הקוד חד-פעמי ותקף עד {fmt.time(code.expiresAt)}. לאחר הצימוד העמדה תופיע ברשימה.</p>
            <Button onClick={() => { setPairOpen(false); router.refresh(); }}>סיום</Button>
          </div>
        )}
      </Dialog>
    </>
  );
}
