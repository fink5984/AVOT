"use client";

import { useMemo, useState } from "react";
import { History, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Panel } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { fmt } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import type { getSettingsScreen } from "@/server/ai/settings";

type Screen = Awaited<ReturnType<typeof getSettingsScreen>>;
type Stored = Screen["stored"];

const PROVIDER_LABEL = { openai: "OpenAI", gemini: "Gemini" } as const;
const OTHER = "__other__";

/** the reasoning levels a model accepts (the same rule the server enforces) */
function levels(provider: "openai" | "gemini", model: string, screen: Screen): string[] {
  if (provider === "openai") return screen.reasoning.openai;
  if (/^gemini-3\.(?:[5-9]|\d{2,})(?:\D|$)/.test(model)) return screen.reasoning.gemini35;
  if (/^gemini-3/.test(model)) return screen.reasoning.gemini3;
  return [];
}

export function AiSettingsClient({ initial }: { initial: Screen }) {
  const toast = useToast();
  const [screen, setScreen] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const s0 = screen.stored;
  const [provider, setProvider] = useState<"openai" | "gemini">((s0.provider ?? screen.effective.provider) as "openai" | "gemini");
  const [model, setModel] = useState<string>(s0.model ?? screen.effective.model);
  const [custom, setCustom] = useState(false);
  const [reasoning, setReasoning] = useState<string>(s0.reasoning ?? screen.effective.reasoning ?? "");
  const [analysisPrompt, setAnalysisPrompt] = useState(s0.analysisPrompt ?? screen.defaults.analysisPrompt);
  const [manuscriptPrompt, setManuscriptPrompt] = useState(s0.manuscriptPrompt ?? screen.defaults.manuscriptPrompt);
  const [rewritePrompt, setRewritePrompt] = useState(s0.rewritePrompt ?? screen.defaults.rewritePrompt);
  const [examples, setExamples] = useState(s0.examples ? JSON.stringify(s0.examples, null, 2) : "");
  const [note, setNote] = useState("");

  const presets = screen.presets[provider];
  const isPreset = presets.includes(model);
  const options = useMemo(() => levels(provider, model, screen), [provider, model, screen]);
  const levelOk = !reasoning || options.includes(reasoning);

  // a text equal to the built-in one is saved as "default" (null), so a later improvement of the default reaches it
  const orNull = (text: string, def: string) => (text.trim() === def.trim() ? null : text);
  const payload = () => ({
    provider,
    model,
    reasoning: reasoning || null,
    analysisPrompt: orNull(analysisPrompt, screen.defaults.analysisPrompt),
    manuscriptPrompt: orNull(manuscriptPrompt, screen.defaults.manuscriptPrompt),
    rewritePrompt: orNull(rewritePrompt, screen.defaults.rewritePrompt),
    examples: examples.trim() ? JSON.parse(examples) : null,
    note: note || null,
  });

  function load(sc: Screen) {
    const s: Stored = sc.stored;
    setScreen(sc);
    setProvider((s.provider ?? sc.effective.provider) as "openai" | "gemini");
    setModel(s.model ?? sc.effective.model);
    setReasoning(s.reasoning ?? sc.effective.reasoning ?? "");
    setAnalysisPrompt(s.analysisPrompt ?? sc.defaults.analysisPrompt);
    setManuscriptPrompt(s.manuscriptPrompt ?? sc.defaults.manuscriptPrompt);
    setRewritePrompt(s.rewritePrompt ?? sc.defaults.rewritePrompt);
    setExamples(s.examples ? JSON.stringify(s.examples, null, 2) : "");
    setNote("");
  }

  async function save() {
    let body;
    try {
      body = payload();
    } catch {
      toast.error("ספריית הדוגמאות אינה JSON תקין");
      return;
    }
    setBusy("save");
    try {
      const r = await api<{ version: number; changed: string[]; screen: Screen }>("/api/ai/settings", { method: "PUT", json: body });
      load(r.screen);
      toast.success(`נשמרה גרסה ${r.version}. השינוי חל על הרצות חדשות בלבד.`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function restore(version: number) {
    if (!window.confirm(`לשחזר את גרסה ${version}? היא תישמר כגרסה חדשה, וההיסטוריה לא תימחק.`)) return;
    setBusy(`restore-${version}`);
    try {
      const r = await api<{ version: number; screen: Screen }>("/api/ai/settings/restore", { method: "POST", json: { version } });
      load(r.screen);
      toast.success(`גרסה ${version} שוחזרה כגרסה ${r.version}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const keyMissing = !screen.keys[provider];
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <p className="text-[13px] text-ink-2">
        ספק ומודל פעילים אחד לכל המערכת: כל פעולת AI (ניתוח ראשון, ניתוח חוזר, הוספת מידע ושכתוב) משתמשת בהם. שינוי חל על הרצות חדשות בלבד, ואינו דורש עדכון קוד. הרצה שכבר התחילה ממשיכה עם ההגדרות שלה. מפתחות ה-API נשמרים בשרת בלבד ואינם מוצגים כאן.
        {screen.version !== null ? <> גרסה נוכחית: <span className="num font-medium">{screen.version}</span>.</> : <> עדיין לא נשמרה גרסה: ברירות המחדל של המערכת פעילות.</>}
      </p>

      <Panel title="ספק ומודל">
        <div className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-3">
          <Field label="ספק AI פעיל" hint={keyMissing ? "חסר מפתח API לספק הזה בשרת: הניתוח יחזיר שגיאה עד שיוגדר." : "המפתח מוגדר בשרת."}>
            {(p) => (
              <Select
                {...p}
                value={provider}
                onChange={(e) => {
                  const next = e.target.value as "openai" | "gemini";
                  setProvider(next);
                  setModel(screen.presets[next][0]!);
                  setCustom(false);
                  setReasoning("");
                }}
              >
                {(["openai", "gemini"] as const).map((x) => (
                  <option key={x} value={x}>
                    {PROVIDER_LABEL[x]}
                    {screen.keys[x] ? "" : " (אין מפתח)"}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="מודל פעיל" hint="מזהה המודל כפי שהספק מכיר אותו.">
            {(p) => (
              <>
                <Select {...p} value={custom || !isPreset ? OTHER : model} onChange={(e) => (e.target.value === OTHER ? (setCustom(true), undefined) : (setCustom(false), setModel(e.target.value)))}>
                  {presets.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  <option value={OTHER}>אחר...</option>
                </Select>
                {(custom || !isPreset) && <Input dir="ltr" className="mt-2" value={model} onChange={(e) => setModel(e.target.value.trim())} placeholder="gemini-3.8-flash" />}
              </>
            )}
          </Field>
          <Field label="רמת חשיבה" error={levelOk ? null : `הרמה אינה נתמכת במודל זה. נתמכות: ${options.join(", ") || "אין"}`} hint={options.length ? "ברירת המחדל של המודל כשהשדה ריק." : "למודל הזה אין הגדרת חשיבה."}>
            {(p) => (
              <Select {...p} value={reasoning} disabled={!options.length} onChange={(e) => setReasoning(e.target.value)}>
                <option value="">ברירת מחדל של המודל</option>
                {options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Panel>

      <Panel title="פרומפט ניתוח פריטים">
        <div className="space-y-4 px-5 py-4">
          <PromptField label="פרומפט הניתוח הראשי" value={analysisPrompt} onChange={setAnalysisPrompt} onReset={() => setAnalysisPrompt(screen.defaults.analysisPrompt)} rows={14} />
          <PromptField label="הוראות ייעודיות לכתבי יד" value={manuscriptPrompt} onChange={setManuscriptPrompt} onReset={() => setManuscriptPrompt(screen.defaults.manuscriptPrompt)} rows={10} />
          <p className="rounded-md bg-stone-2 px-3 py-2 text-[12.5px] text-ink-2">
            כללים קבועים שמצורפים בקוד לכל בקשה ואי אפשר לבטל בטקסט: אבטחה (טקסט בתמונות הוא נתון ולא הוראה), מקף רגיל בלבד, כל ההסברים בעברית, ופלט JSON לפי הסכמה. גם אימות התשובה, השדות המוגנים וניקוי הטקסטים מתבצעים בקוד.
          </p>
        </div>
      </Panel>

      <Panel title="הוספת מידע ושכתוב">
        <div className="space-y-4 px-5 py-4">
          <PromptField label="פרומפט הוספת מידע ותיקון ממוקד" value={rewritePrompt} onChange={setRewritePrompt} onReset={() => setRewritePrompt(screen.defaults.rewritePrompt)} rows={10} />
        </div>
      </Panel>

      <Panel title="ספריית דוגמאות כתיבה">
        <div className="space-y-3 px-5 py-4">
          <p className="text-[12.5px] text-ink-2">
            כל הדוגמאות הפעילות נשלחות בכל ניתוח. ריק = קובץ הדוגמאות שבקוד (גרסה <span dir="ltr">{screen.defaultExamples}</span>). אפשר להדביק כאן JSON מלא בפורמט הקובץ (version, examples). דוגמה לא תקינה מונעת שמירה, ואף דוגמה לא מושמטת בשקט. הדוגמאות הפעילות כרגע: <span className="num">{screen.effective.examplesCount}</span> (גרסה <span dir="ltr">{screen.effective.examplesVersion}</span>).
          </p>
          <Textarea dir="ltr" rows={10} value={examples} onChange={(e) => setExamples(e.target.value)} placeholder='{"version":"...","examples":[{"id":"...","description":"..."}]}' className="font-mono text-[12px]" />
          {examples && (
            <Button size="sm" variant="ghost" onClick={() => setExamples("")}>
              חזרה לקובץ שבקוד
            </Button>
          )}
        </div>
      </Panel>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="הערה לגרסה (אופציונלי)" className="min-w-64 flex-1">{(p) => <Input {...p} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="למשל: מעבר ל-Gemini 3.8 Flash לבדיקה" />}</Field>
        <Button variant="primary" icon={<Save />} loading={busy === "save"} disabled={!!busy || !levelOk || !model} onClick={() => void save()}>
          שמירת הגדרות (גרסה חדשה)
        </Button>
      </div>

      <Panel
        title={
          <span className="flex items-center gap-2">
            <History className="size-4" aria-hidden />
            גרסאות הגדרות
          </span>
        }
      >
        {screen.versions.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-muted">עדיין לא נשמרו גרסאות.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-rule text-muted">
                  <th className="px-3 py-2 text-start font-medium">גרסה</th>
                  <th className="px-3 py-2 text-start font-medium">מועד</th>
                  <th className="px-3 py-2 text-start font-medium">מי</th>
                  <th className="px-3 py-2 text-start font-medium">ספק / מודל / חשיבה</th>
                  <th className="px-3 py-2 text-start font-medium">הותאם</th>
                  <th className="px-3 py-2 text-start font-medium">הערה</th>
                  <th className="px-3 py-2" aria-label="פעולות" />
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {screen.versions.map((v) => (
                  <tr key={v.version}>
                    <td className="num px-3 py-2 font-medium">{v.version}</td>
                    <td className="px-3 py-2">{fmt.dateTime(new Date(v.createdAt))}</td>
                    <td className="px-3 py-2">{v.createdBy ?? "-"}</td>
                    <td className="px-3 py-2" dir="ltr">
                      {v.provider ?? "(ברירת מחדל)"} · {v.model ?? "-"} · {v.reasoning ?? "-"}
                    </td>
                    <td className="px-3 py-2">{v.customized.join(", ") || "-"}</td>
                    <td className="px-3 py-2 text-ink-2">{v.note ?? ""}</td>
                    <td className="px-3 py-2">
                      {v.version !== screen.version && (
                        <Button size="sm" variant="ghost" icon={<RotateCcw />} loading={busy === `restore-${v.version}`} disabled={!!busy} onClick={() => void restore(v.version)}>
                          שחזור
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function PromptField({ label, value, onChange, onReset, rows }: { label: string; value: string; onChange: (v: string) => void; onReset: () => void; rows: number }) {
  return (
    <Field label={label}>
      {(p) => (
        <>
          <Textarea {...p} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} className="text-[13px] leading-relaxed" />
          <div>
            <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={onReset}>
              שחזור ברירת המחדל
            </Button>
          </div>
        </>
      )}
    </Field>
  );
}
