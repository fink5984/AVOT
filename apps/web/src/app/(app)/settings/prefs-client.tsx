"use client";

import { useEffect, useState } from "react";
import { PHOTO_CATEGORIES } from "@avot/shared";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Switch } from "@/components/ui/field";
import { Kbd, Panel } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { t } from "@/i18n";
import { DEFAULT_PREFS, keyLabel, mergePrefs, playShutter, savePrefs, type CapturePrefs } from "@/lib/capture/prefs";
import { cn } from "@/lib/cn";

type KeyField = "captureKey" | "nextLotKey" | "prevLotKey" | `cat${0 | 1 | 2 | 3}`;

export function CapturePrefsForm({ serverPrefs }: { serverPrefs: unknown }) {
  const toast = useToast();
  const [prefs, setPrefs] = useState<CapturePrefs>(DEFAULT_PREFS);
  const [learning, setLearning] = useState<KeyField | null>(null);
  const [saving, setSaving] = useState(false);
  const [tester, setTester] = useState<{ code: string; key: string; at: number }[]>([]);
  const [testerOn, setTesterOn] = useState(false);

  useEffect(() => setPrefs(mergePrefs(serverPrefs)), [serverPrefs]);

  useEffect(() => {
    if (!learning && !testerOn) return;
    const onKey = (e: KeyboardEvent) => {
      if (learning) {
        e.preventDefault();
        e.stopPropagation();
        if (e.code === "Escape") return setLearning(null);
        const code = e.code;
        setPrefs((p) => {
          if (learning.startsWith("cat")) {
            const keys = [...p.categoryKeys] as CapturePrefs["categoryKeys"];
            keys[Number(learning.slice(3))] = code;
            return { ...p, categoryKeys: keys };
          }
          return { ...p, [learning]: code };
        });
        setLearning(null);
        return;
      }
      if (testerOn) {
        e.preventDefault();
        setTester((xs) => [{ code: e.code || "(ללא code)", key: e.key, at: Date.now() }, ...xs].slice(0, 8));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [learning, testerOn]);

  async function save() {
    const codes = [prefs.captureKey, prefs.nextLotKey, prefs.prevLotKey, ...prefs.categoryKeys].filter(Boolean) as string[];
    if (new Set(codes).size !== codes.length) {
      toast.error("אותו מקש הוגדר ליותר מפעולה אחת");
      return;
    }
    if (codes.includes("Space")) {
      toast.error("מקש הרווח שמור תמיד לצילום — בחרו מקש אחר");
      return;
    }
    setSaving(true);
    try {
      await savePrefs(prefs);
      toast.success("ההעדפות נשמרו");
    } catch {
      toast.error("השמירה נכשלה — נסו שוב");
    } finally {
      setSaving(false);
    }
  }

  const KeyButton = ({ field, value }: { field: KeyField; value: string | null }) => (
    <button
      type="button"
      onClick={() => setLearning(field)}
      className={cn(
        "inline-flex h-9 min-w-28 items-center justify-center gap-2 rounded-md border px-3 text-[13px] transition-colors",
        learning === field ? "border-accent bg-accent-soft text-accent-2" : "border-rule-strong bg-paper shadow-card hover:bg-stone-2",
      )}
    >
      {learning === field ? "לחצו על מקש…" : <Kbd>{keyLabel(value)}</Kbd>}
    </button>
  );

  return (
    <div className="space-y-5">
      <Panel title="מקשי קיצור">
        <div className="space-y-3 px-5 py-4 text-[13.5px]">
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-48">צילום</span>
            <Kbd>רווח</Kbd>
            <span className="text-muted">וגם</span>
            <KeyButton field="captureKey" value={prefs.captureKey} />
            {prefs.captureKey && (
              <button className="text-[12px] text-muted hover:text-ink" onClick={() => setPrefs((p) => ({ ...p, captureKey: null }))}>
                הסרה
              </button>
            )}
            <span className="w-full text-[12px] text-muted">מקש נוסף לצילום — לדוגמה דוושת USB המדמה מקש (PageDown, F13, Enter…).</span>
          </div>
          {PHOTO_CATEGORIES.map((c, i) => (
            <div key={c} className="flex items-center gap-3">
              <span className="w-48">מעבר ל{t.category[c]}</span>
              <KeyButton field={`cat${i as 0 | 1 | 2 | 3}`} value={prefs.categoryKeys[i]!} />
            </div>
          ))}
          <div className="flex items-center gap-3">
            <span className="w-48">פריט הבא</span>
            <KeyButton field="nextLotKey" value={prefs.nextLotKey} />
          </div>
          <div className="flex items-center gap-3">
            <span className="w-48">פריט קודם</span>
            <KeyButton field="prevLotKey" value={prefs.prevLotKey} />
          </div>
          <p className="text-[12px] text-muted">
            המקשים נשמרים לפי מיקומם הפיזי, ולכן פועלים גם כשהמקלדת בעברית. במסך הצילום: G רשת · Z הגדלה · R סיבוב תצוגה · F מסך מלא · H הסתרת פאנלים. קיצורים אינם פועלים בזמן הקלדה בשדה טקסט.
          </p>
        </div>
      </Panel>

      <Panel title="בדיקת מקש / דוושת USB">
        <div className="space-y-3 px-5 py-4 text-[13.5px]">
          <p className="text-ink-2">חברו את הדוושה, הפעילו את הבדיקה ולחצו עליה. אם היא מזוהה יופיע כאן שם המקש שהיא שולחת — ואפשר להגדיר אותו כמקש הצילום.</p>
          <div className="flex gap-2">
            <Button variant={testerOn ? "primary" : "secondary"} onClick={() => setTesterOn((x) => !x)}>
              {testerOn ? "עצירת הבדיקה" : "התחלת בדיקה"}
            </Button>
            {tester[0] && (
              <Button onClick={() => setPrefs((p) => ({ ...p, captureKey: tester[0]!.code }))}>הגדרת {keyLabel(tester[0].code)} כמקש צילום</Button>
            )}
          </div>
          {testerOn && (
            <div className="min-h-24 rounded-lg border-2 border-dashed border-rule-strong bg-stone-2 px-4 py-3" aria-live="polite">
              {tester.length === 0 ? (
                <p className="text-muted">ממתין ללחיצה…</p>
              ) : (
                <ul className="space-y-1">
                  {tester.map((k) => (
                    <li key={k.at} className="flex items-center gap-3">
                      <Kbd>{keyLabel(k.code)}</Kbd>
                      <span className="font-mono text-[12px] text-muted" dir="ltr">
                        code={k.code} key={k.key}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </Panel>

      <Panel title="מסך הצילום">
        <div className="grid gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-2">
          <div className="flex items-center gap-3 sm:col-span-2">
            <Switch label="צליל אישור בכל צילום" checked={prefs.sound} onChange={(e) => setPrefs((p) => ({ ...p, sound: e.target.checked }))} className="flex-1" />
            <Button size="sm" variant="ghost" onClick={playShutter}>
              השמעה
            </Button>
          </div>
          <Switch
            label="צילום רציף — מעבר אוטומטי לפריט הבא בסיום פריט"
            checked={prefs.continuous}
            onChange={(e) => setPrefs((p) => ({ ...p, continuous: e.target.checked }))}
            className="sm:col-span-2"
          />
          <Field label="סטטוס בעת ״סיום פריט״">
            {(f) => (
              <Select {...f} value={prefs.completeStatus} onChange={(e) => setPrefs((p) => ({ ...p, completeStatus: e.target.value as CapturePrefs["completeStatus"] }))}>
                <option value="COMPLETED">{t.lotStatus.COMPLETED}</option>
                <option value="PENDING_REVIEW">{t.lotStatus.PENDING_REVIEW}</option>
              </Select>
            )}
          </Field>
          <Field label="רשת עזר כברירת מחדל">
            {(f) => (
              <Select {...f} value={prefs.grid} onChange={(e) => setPrefs((p) => ({ ...p, grid: e.target.value as CapturePrefs["grid"] }))}>
                <option value="none">ללא</option>
                <option value="thirds">שלישים</option>
                <option value="fine">צפופה</option>
              </Select>
            )}
          </Field>
          <Field label="כתובת Capture Agent" hint="ברירת מחדל: http://127.0.0.1:47800 — לשנות רק אם הוגדר פורט אחר בתוכנה" className="sm:col-span-2">
            {(f) => <Input {...f} dir="ltr" value={prefs.agentUrl} onChange={(e) => setPrefs((p) => ({ ...p, agentUrl: e.target.value.trim() }))} pattern="^http://(127\.0\.0\.1|localhost):\d+$" />}
          </Field>
        </div>
      </Panel>

      <div className="flex gap-2">
        <Button variant="primary" loading={saving} onClick={save}>
          שמירת ההעדפות
        </Button>
        <Button onClick={() => setPrefs({ ...DEFAULT_PREFS, lastCamera: prefs.lastCamera })}>שחזור ברירות מחדל</Button>
      </div>
    </div>
  );
}
