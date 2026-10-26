"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/field";
import type { CameraControl } from "@/lib/capture/drivers/types";

/** One camera control, rendered from what the camera / driver reports (range, select, toggle or action). */
export function ControlRow({ control: c, onChange, tone = "studio" }: { control: CameraControl; onChange: (v: number | string | boolean) => void; tone?: "studio" | "light" }) {
  const [local, setLocal] = useState(c.value);
  useEffect(() => setLocal(c.value), [c.value]);
  const studio = tone === "studio";
  const muted = studio ? "text-studio-muted" : "text-muted";
  if (c.type === "action") {
    return (
      <Button size="sm" variant={studio ? "studio" : "secondary"} onClick={() => onChange(true)} className="w-full">
        {c.label}
      </Button>
    );
  }
  if (c.type === "toggle") {
    return (
      <Switch
        tone={studio ? "studio" : "light"}
        label={<span className={muted}>{c.label}</span>}
        checked={!!local}
        disabled={c.readOnly}
        onChange={(e) => {
          setLocal(e.target.checked);
          onChange(e.target.checked);
        }}
        aria-label={c.label}
      />
    );
  }
  return (
    <div>
      <div className="mb-1.5 flex justify-between gap-2">
        <span className={muted}>{c.label}</span>
        {c.type === "range" && <span className="num">{c.display ?? (typeof local === "number" ? Number(local.toFixed(2)) : "—")}</span>}
      </div>
      {c.type === "range" && (
        <input
          type="range"
          min={c.min}
          max={c.max}
          step={c.step}
          value={typeof local === "number" ? local : c.min}
          disabled={c.readOnly}
          onChange={(e) => setLocal(Number(e.target.value))}
          onPointerUp={(e) => onChange(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => onChange(Number((e.target as HTMLInputElement).value))}
          className={studio ? "w-full accent-[#ededea]" : "w-full accent-[var(--color-ink)]"}
          dir="ltr"
          aria-label={c.label}
        />
      )}
      {c.type === "select" && (
        <select
          value={String(local ?? "")}
          disabled={c.readOnly}
          onChange={(e) => {
            setLocal(e.target.value);
            onChange(e.target.value);
          }}
          className={studio ? "h-9 w-full rounded-md border border-studio-rule bg-studio-3 px-2 text-[13px] text-studio-text" : "h-9 w-full rounded-md border border-rule-strong bg-paper px-2 text-[13px] text-ink"}
          aria-label={c.label}
        >
          {c.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
