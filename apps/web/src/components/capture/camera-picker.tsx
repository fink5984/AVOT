"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Camera, FlaskConical, MonitorSmartphone, RefreshCw, Smartphone } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { listWebcams } from "@/lib/capture/drivers/webcam";
import { probeAgent, type AgentHello } from "@/lib/capture/drivers/agent";
import type { CameraKind } from "@/lib/capture/drivers/types";
import { cn } from "@/lib/cn";

export type CameraChoice =
  | { kind: "WEBCAM"; id: string; label: string }
  | { kind: "SIMULATOR"; id: "simulator"; label: string }
  | { kind: "CANON" | "AGENT_SIMULATOR"; id: string; label: string; agentUrl: string; cameraKind: "CANON" | "SIMULATOR" | "NONE" };

interface StationDto {
  id: string;
  name: string;
  online: boolean;
}

export function CameraPicker({
  open,
  onClose,
  onPick,
  current,
  agentUrl,
  simulatorAllowed,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (c: CameraChoice) => void;
  current: { kind: CameraKind; id: string } | null;
  agentUrl: string;
  simulatorAllowed: boolean;
}) {
  const [webcams, setWebcams] = useState<{ deviceId: string; label: string }[] | null>(null);
  const [agent, setAgent] = useState<AgentHello | null | undefined>(undefined);
  const [stations, setStations] = useState<StationDto[]>([]);
  const [camError, setCamError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setWebcams(null);
    setAgent(undefined);
    setCamError(null);
    const [cams, hello, st] = await Promise.all([
      listWebcams().catch((e) => {
        setCamError(String(e?.message ?? e));
        return [];
      }),
      probeAgent(agentUrl),
      fetch("/api/devices", { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : { devices: [] }))
        .then((d: { devices: StationDto[] }) => d.devices)
        .catch(() => []),
    ]);
    setWebcams(cams);
    setAgent(hello);
    setStations(st);
  }, [agentUrl]);

  useEffect(() => {
    if (open) void scan();
  }, [open, scan]);

  const station = agent?.deviceId ? stations.find((s) => s.id === agent.deviceId) : undefined;

  const Option = ({ active, icon, title, sub, onClick, disabled }: { active: boolean; icon: React.ReactNode; title: string; sub?: React.ReactNode; onClick: () => void; disabled?: boolean }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border px-3.5 py-3 text-start transition-colors disabled:opacity-50",
        active ? "border-ink bg-stone-2 ring-1 ring-ink" : "border-rule hover:border-rule-strong hover:bg-stone-2",
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-stone text-ink-2 [&>svg]:size-4.5">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium">{title}</span>
        {sub && <span className="mt-0.5 block text-[12px] text-muted">{sub}</span>}
      </span>
    </button>
  );

  return (
    <Dialog open={open} onClose={onClose} title="בחירת מצלמה" description="אותו מסך צילום לכל סוגי המצלמות. מוצגות רק אפשרויות שהמצלמה הנבחרת תומכת בהן." width="md">
      <div className="space-y-5">
        <section>
          <h3 className="eyebrow mb-2">Canon דרך Capture Agent</h3>
          {agent === undefined ? (
            <p className="text-[12.5px] text-muted">בודק אם Capture Agent פועל במחשב זה…</p>
          ) : agent === null ? (
            <div className="rounded-lg border border-dashed border-rule-strong px-3.5 py-3 text-[13px] text-muted">
              Capture Agent לא זוהה במחשב זה ({agentUrl}). הוא נדרש לשליטה במצלמת Canon EOS R7 דרך USB.{" "}
              <Link href="/settings/stations#install" className="text-accent-2 underline underline-offset-2">
                הוראות התקנה וצימוד
              </Link>
            </div>
          ) : !agent.paired || !station ? (
            <div className="rounded-lg bg-warn-soft px-3.5 py-3 text-[13px] text-warn">
              Capture Agent {agent.version} פועל, אך {agent.paired ? "שייך לארגון או לשרת אחר" : "עדיין לא צומד לחשבון"}.{" "}
              <Link href="/settings/stations" className="underline underline-offset-2">
                צימוד עמדה
              </Link>
            </div>
          ) : (
            <Option
              active={current?.id === station.id}
              icon={agent.camera.kind === "SIMULATOR" ? <FlaskConical /> : <Camera />}
              title={agent.camera.kind === "SIMULATOR" ? `סימולטור Capture Agent — ${station.name}` : `${agent.camera.model ?? "מצלמת Canon"} — ${station.name}`}
              sub={agent.camera.connected ? "מחוברת ב-USB" : agent.camera.kind === "NONE" ? "לא זוהתה מצלמה — חברו את המצלמה והדליקו אותה" : "המצלמה מנותקת"}
              onClick={() =>
                onPick({
                  kind: agent.camera.kind === "SIMULATOR" ? "AGENT_SIMULATOR" : "CANON",
                  id: station.id,
                  label: station.name,
                  agentUrl,
                  cameraKind: agent.camera.kind,
                })
              }
            />
          )}
        </section>

        <section>
          <h3 className="eyebrow mb-2">מצלמות רשת וסמארטפון</h3>
          {webcams === null ? (
            <p className="text-[12.5px] text-muted">מחפש מצלמות…</p>
          ) : webcams.length === 0 ? (
            <p className="text-[12.5px] text-muted">
              {camError ?? "לא נמצאו מצלמות רשת."} לחיבור סמארטפון כמצלמת רשת ראו{" "}
              <Link href="/settings#phone" className="text-accent-2 underline underline-offset-2">
                הוראות חיבור טלפון
              </Link>
              .
            </p>
          ) : (
            <div className="space-y-1.5">
              {webcams.map((w) => (
                <Option
                  key={w.deviceId}
                  active={current?.kind === "WEBCAM" && current.id === w.deviceId}
                  icon={/phone|android|iphone|droid|camo|link/i.test(w.label) ? <Smartphone /> : <MonitorSmartphone />}
                  title={w.label}
                  sub="תצוגה חיה וצילום בדפדפן · השמירה דרך תור ההעלאה המאובטח"
                  onClick={() => onPick({ kind: "WEBCAM", id: w.deviceId, label: w.label })}
                />
              ))}
            </div>
          )}
        </section>

        {simulatorAllowed && (
          <section>
            <h3 className="eyebrow mb-2">פיתוח ובדיקות</h3>
            <Option
              active={current?.kind === "SIMULATOR"}
              icon={<FlaskConical />}
              title="סימולטור מצלמה (דפדפן)"
              sub="תמונות בדיקה מסומנות SIMULATOR — לבדיקות בלבד"
              onClick={() => onPick({ kind: "SIMULATOR", id: "simulator", label: "סימולטור" })}
            />
          </section>
        )}

        <div className="flex items-center justify-between border-t border-rule pt-3">
          <Button size="sm" variant="ghost" icon={<RefreshCw />} onClick={scan}>
            סריקה מחדש
          </Button>
          <Button size="sm" onClick={onClose}>
            סגירה
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
