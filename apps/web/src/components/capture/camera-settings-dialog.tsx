"use client";

import { useState } from "react";
import { Crosshair, Star, Trash2 } from "lucide-react";
import type { ProcessingSettings } from "@avot/shared";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Select, Switch } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import type { CameraControl, CameraInfo } from "@/lib/capture/drivers/types";
import type { CameraProfileDto } from "@/server/services/camera-profiles";
import { ControlRow } from "./control-row";

function Section({ title, hint, children }: { title: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-rule pt-4 first:border-t-0 first:pt-0">
      <h3 className="mb-2.5 text-[13px] font-semibold text-ink">{title}</h3>
      <div className="space-y-3">{children}</div>
      {hint && <p className="mt-2 text-[12px] leading-snug text-muted">{hint}</p>}
    </section>
  );
}

function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-rule-strong bg-paper p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("h-8 rounded-[5px] px-3 text-[13px] transition-colors", value === o.value ? "bg-ink text-paper" : "text-ink-2 hover:bg-stone")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Slider({ label, value, min, max, step = 1, unit = "", onChange, hint }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 flex justify-between text-[13px]">
        <span>{label}</span>
        <span className="num text-muted">
          {value}
          {unit}
        </span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--color-ink)]" dir="ltr" />
      {hint && <span className="mt-0.5 block text-[12px] text-muted">{hint}</span>}
    </label>
  );
}

/** A quality / format control whose current value is RAW only: nothing can be cropped from a RAW file. */
function rawOnly(controls: CameraControl[]) {
  return controls.some((c) => /compress|quality|format/i.test(c.id) && typeof c.value === "string" && /raw/i.test(c.value) && !/jpe?g/i.test(c.value));
}

/**
 * Camera + image-processing settings, reachable at any moment from the capture screen. Every change
 * applies immediately (live view, the next shot) and is saved to the active profile.
 */
export function CameraSettingsDialog({
  open,
  onClose,
  connected,
  info,
  controls,
  onControl,
  settings,
  onPatch,
  profiles,
  activeId,
  saving,
  onSelectProfile,
  onMakeDefault,
  onCreateProfile,
  onDeleteProfile,
  onSaveCameraValues,
  onCalibrate,
}: {
  open: boolean;
  onClose: () => void;
  connected: boolean;
  info: CameraInfo | null;
  controls: CameraControl[];
  onControl: (id: string, v: number | string | boolean) => void;
  settings: ProcessingSettings;
  onPatch: (p: Partial<ProcessingSettings>) => void;
  profiles: CameraProfileDto[] | null;
  activeId: string | undefined;
  saving: boolean;
  onSelectProfile: (id: string) => void;
  onMakeDefault: () => void;
  onCreateProfile: (name: string) => void;
  onDeleteProfile: (id: string) => void;
  onSaveCameraValues: () => void;
  onCalibrate: () => void;
}) {
  const [newName, setNewName] = useState<string | null>(null);
  const active = profiles?.find((p) => p.id === activeId);
  const bgKind = settings.background === "transparent" ? "transparent" : settings.background.toLowerCase() === "#ffffff" ? "white" : "color";
  const settable = controls.filter((c) => c.type !== "action");
  const actions = controls.filter((c) => c.type === "action");

  return (
    <Dialog open={open} onClose={onClose} title="הגדרות מצלמה" description="השינויים חלים מיד ונשמרים בפרופיל הצילום. אין צורך לבחור מחדש בכל צילום." width="lg">
      <div className="space-y-4 text-[13.5px]">
        <Section title="פרופיל צילום" hint={saving ? "שומר…" : "נשמר אוטומטית. הפרופיל נטען בכל כניסה למסך הצילום."}>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={activeId ?? ""} onChange={(e) => onSelectProfile(e.target.value)} className="w-56" aria-label="פרופיל פעיל">
              {(profiles ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.isDefault ? " (ברירת מחדל)" : ""}
                </option>
              ))}
            </Select>
            <Button size="sm" icon={<Star />} disabled={!active || active.isDefault} onClick={onMakeDefault}>
              קביעה כברירת מחדל
            </Button>
            <Button size="sm" disabled={!active} onClick={() => setNewName("")}>
              פרופיל חדש…
            </Button>
            <Button size="sm" variant="danger" icon={<Trash2 />} disabled={!active || active.isDefault} onClick={() => active && onDeleteProfile(active.id)} aria-label="מחיקת הפרופיל">
              מחיקה
            </Button>
          </div>
          {newName !== null && (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (newName.trim()) onCreateProfile(newName.trim());
                setNewName(null);
              }}
            >
              <Input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="שם הפרופיל (למשל: ספרים גדולים)" className="w-64" maxLength={80} />
              <Button type="submit" variant="primary" size="sm">
                יצירה
              </Button>
              <Button size="sm" onClick={() => setNewName(null)}>
                ביטול
              </Button>
            </form>
          )}
        </Section>

        <Section
          title="מצלמה"
          hint="מוצגות רק האפשרויות שהמצלמה והדרייבר מדווחים עליהן בפועל. ערכי המצלמה נשמרים בפרופיל ומוחזרים בכל חיבור."
        >
          {!connected || settable.length === 0 ? (
            <p className="rounded-md bg-stone px-3 py-2 text-muted">{connected ? "המצלמה אינה מדווחת על הגדרות הניתנות לשינוי מכאן." : "המצלמה אינה מחוברת — אפשר עדיין לערוך את הגדרות העיבוד שלמטה."}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {settable.map((c) => (
                <ControlRow key={c.id} tone="light" control={c} onChange={(v) => onControl(c.id, v)} />
              ))}
            </div>
          )}
          {connected && actions.length > 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {actions.map((c) => (
                <ControlRow key={c.id} tone="light" control={c} onChange={(v) => onControl(c.id, v)} />
              ))}
            </div>
          )}
          {rawOnly(controls) && <p className="rounded-md bg-warn-soft px-3 py-2 text-[12.5px] text-warn">הפורמט הנוכחי הוא RAW בלבד — חיתוך והסרת רקע אוטומטיים פועלים על קובץ JPEG. בחרו JPEG או RAW+JPEG.</p>}
          {info?.formats && info.formats.length > 0 && <p className="text-[12.5px] text-muted">פורמט נוכחי: {info.formats.join(" + ")}</p>}
          <Button size="sm" disabled={!connected || settable.length === 0} onClick={onSaveCameraValues}>
            שמירת הגדרות המצלמה הנוכחיות בפרופיל
          </Button>
        </Section>

        <Section title="סיבוב התמונה" hint="חל על התצוגה החיה ועל הקובץ המעובד (בפיקסלים). הקובץ המקורי נשמר כפי שצולם. 180° — מצלמה מעל המשטח כשהספר פונה אל הצלם.">
          <Seg
            label="סיבוב"
            value={settings.rotation}
            onChange={(v) => onPatch({ rotation: v })}
            options={[0, 90, 180, 270].map((r) => ({ value: r as 0 | 90 | 180 | 270, label: `${r}°` }))}
          />
        </Section>

        <Section title="חיתוך והסרת רקע" hint="הסרת הרקע ממירה את הירוק לשקוף / לצבע הרקע; חיתוך מצמצם את התמונה למלבן הקטן ביותר שמכיל את הספר, בתוספת שוליים.">
          <Switch label="הסרת רקע ירוק" checked={settings.removeBackground} onChange={(e) => onPatch({ removeBackground: e.target.checked })} />
          <Switch label="חיתוך אוטומטי לפי הספר" checked={settings.autoCrop} onChange={(e) => onPatch({ autoCrop: e.target.checked })} />
          <Slider label="רגישות זיהוי הרקע" value={settings.sensitivity} min={0} max={100} step={5} onChange={(v) => onPatch({ sensitivity: v })} hint="גבוה: יותר גוונים ירקרקים נחשבים רקע. נמוך: יותר פרטים נשמרים." />
          <Seg
            label="איכות הקצה"
            value={settings.edgeQuality}
            onChange={(v) => onPatch({ edgeQuality: v })}
            options={[
              { value: "precise" as const, label: "מדויק" },
              { value: "natural" as const, label: "טבעי" },
              { value: "soft" as const, label: "רך" },
            ]}
          />
          <p className="-mt-1 text-[12px] text-muted">מדויק: קצה חד. טבעי: קצה רך ללא שאריות ירוק (ברירת מחדל). רך: מעבר רחב — פינות שחוקות.</p>
          <Slider label="שוליים סביב הספר" value={settings.marginPct} min={0} max={15} step={0.5} unit="%" onChange={(v) => onPatch({ marginPct: v })} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon={<Crosshair />} onClick={onCalibrate} disabled={!connected}>
              כיול צבע הרקע מהתצוגה החיה
            </Button>
            {settings.bgSample && (
              <>
                <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
                  <span className="size-4 rounded-full border border-rule-strong" style={{ background: `hsl(${settings.bgSample.h} ${Math.round(settings.bgSample.s * 100)}% ${Math.round(settings.bgSample.v * 55)}%)` }} aria-hidden />
                  מכויל
                </span>
                <Button size="sm" variant="ghost" onClick={() => onPatch({ bgSample: null })}>
                  חזרה לזיהוי אוטומטי
                </Button>
              </>
            )}
          </div>
        </Section>

        <Section title="רקע ופורמט סופי" hint="ברירת מחדל: חתוך על רקע לבן. רקע שקוף נשמר כ-PNG.">
          <Seg
            label="רקע"
            value={bgKind}
            onChange={(v) => onPatch({ background: v === "transparent" ? "transparent" : v === "white" ? "#ffffff" : settings.background === "transparent" || settings.background.toLowerCase() === "#ffffff" ? "#f4f1ea" : settings.background })}
            options={[
              { value: "white", label: "לבן" },
              { value: "transparent", label: "שקוף (PNG)" },
              { value: "color", label: "צבע" },
            ]}
          />
          {bgKind === "color" && (
            <input type="color" value={settings.background} onChange={(e) => onPatch({ background: e.target.value })} className="h-9 w-16 cursor-pointer rounded-md border border-rule-strong bg-paper" aria-label="צבע הרקע" />
          )}
          {bgKind !== "transparent" && (
            <>
              <Seg label="פורמט" value={settings.format} onChange={(v) => onPatch({ format: v })} options={[{ value: "jpeg", label: "JPEG" }, { value: "png", label: "PNG" }]} />
              {settings.format === "jpeg" && <Slider label="איכות JPEG" value={settings.jpegQuality} min={80} max={100} onChange={(v) => onPatch({ jpegQuality: v })} />}
            </>
          )}
        </Section>

        <Section title="תצוגה חיה" hint="התצוגה החיה היא הערכה בלבד, ברזולוציה נמוכה. כל צילום מעובד מחדש ברזולוציה המלאה של המקור.">
          <Seg
            label="מצב תצוגה חיה"
            value={settings.liveMode}
            onChange={(v) => onPatch({ liveMode: v })}
            options={[
              { value: "processed", label: "מעובדת" },
              { value: "frame", label: "מסגרת חיתוך" },
              { value: "full", label: "מלאה" },
            ]}
          />
        </Section>
      </div>
      <div className="mt-5 flex justify-end">
        <Button variant="primary" onClick={onClose}>
          סגירה
        </Button>
      </div>
    </Dialog>
  );
}
