"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, CircleAlert, Clock, Keyboard, LogOut, MapPin, RefreshCw, TriangleAlert, Wifi, WifiOff } from "lucide-react";
import { SCAN_MODES, classifyCode, type ScanMode, type ScanOpInput, type ScanResponse } from "@avot/shared";
import { t } from "@/i18n";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { attachAdapter, createDebouncer, feedback } from "@/lib/scanner/input";
import { scanQueue, type QueuedScan, type ScanStatus } from "@/lib/scanner/queue";

interface Loc {
  id: string;
  code: string;
  label: string;
}
interface Result {
  kind: "ok" | "warn" | "error" | "queued";
  title: string;
  lines: string[];
  item?: ScanResponse["item"];
}
interface PickRow {
  id: string;
  status: string;
  item: { id: string; inventoryNumber: string; title: string };
  location: { code: string; label: string } | null;
}
interface CountRow {
  id: string;
  status: string;
  zone: string | null;
  entries: number;
}

const STATUS_LABEL: Record<ScanStatus, string> = { pending: "ממתין לסנכרון", synced: "נשמר בשרת", error: "נכשל", conflict: "דורש טיפול" };
const STATUS_TONE: Record<ScanStatus, string> = {
  pending: "bg-[#5b4210] text-[#ffd98a]",
  synced: "bg-[#123d29] text-[#8ff0bf]",
  error: "bg-[#4a1514] text-[#ffb4ab]",
  conflict: "bg-[#4a2a07] text-[#ffc46b]",
};
const LS_KEY = "avot.scanner";

function statusOf(r: ScanResponse): ScanStatus {
  return r.result === "OK" || r.result === "NOOP" ? "synced" : r.result === "CONFLICT" ? "conflict" : "error";
}

function toResult(r: ScanResponse): Result {
  const lines: string[] = [];
  if (r.item) {
    lines.push(`${r.item.inventoryNumber} · ${r.item.title}`);
    lines.push(r.item.location ? `מיקום: ${r.item.location.code}` : "ללא מיקום במחסן");
  }
  const kind: Result["kind"] = r.result === "OK" && !r.warning ? "ok" : r.result === "ERROR" || r.result === "CONFLICT" ? "error" : "warn";
  return { kind, title: r.message, lines, item: r.item };
}

export function ScannerApp({ user, perms }: { user: { id: string; name: string }; perms: { operate: boolean; manage: boolean } }) {
  const [mode, setModeState] = useState<ScanMode>(perms.operate ? "STORE" : "FIND");
  const [active, setActive] = useState<Loc | null>(null);
  const [count, setCount] = useState<{ id: string; zone: string | null } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [log, setLog] = useState<QueuedScan[]>([]);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);
  const [picks, setPicks] = useState<PickRow[]>([]);
  const [counts, setCounts] = useState<CountRow[]>([]);
  const [zones, setZones] = useState<{ id: string; name: string }[]>([]);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const locCache = useRef<Map<string, Loc>>(new Map());
  const debounce = useMemo(() => createDebouncer(700), []);
  const stateRef = useRef({ mode, active, count });
  stateRef.current = { mode, active, count };

  const allowedModes = SCAN_MODES.filter((m) => m === "FIND" || perms.operate);

  // ── persisted UI state (mode, active shelf, count session) survives reloads ──
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as { mode?: ScanMode; active?: Loc; count?: { id: string; zone: string | null } };
      if (s.mode && allowedModes.includes(s.mode)) setModeState(s.mode);
      if (s.active) setActive(s.active);
      if (s.count) setCount(s.count);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ mode, active, count }));
    } catch {
      /* private mode */
    }
  }, [mode, active, count]);

  const refreshLog = useCallback(async () => setLog(await scanQueue.list(user.id, 40)), [user.id]);

  // ── location cache: lets a shelf scan work while offline ──
  const loadLocations = useCallback(async () => {
    try {
      const r = await api<{ warehouses: { name: string; isDefault: boolean; zones: { id: string; name: string; code: string; shelves: { code: string; locations: { id: string; code: string; cell: string; active: boolean }[] }[] }[] }[] }>("/api/warehouse");
      const map = new Map<string, Loc>();
      const zs: { id: string; name: string }[] = [];
      for (const w of r.warehouses)
        for (const z of w.zones) {
          zs.push({ id: z.id, name: `${w.isDefault ? "" : `${w.name} · `}${z.name}` });
          for (const s of z.shelves)
            for (const l of s.locations) if (l.active) map.set(l.code, { id: l.id, code: l.code, label: [w.isDefault ? null : w.name, z.name, `מדף ${s.code}`, `תא ${l.cell}`].filter(Boolean).join(" › ") });
        }
      locCache.current = map;
      setZones(zs);
      localStorage.setItem(`${LS_KEY}.locations`, JSON.stringify([...map.values()]));
    } catch {
      try {
        const cached = JSON.parse(localStorage.getItem(`${LS_KEY}.locations`) ?? "[]") as Loc[];
        locCache.current = new Map(cached.map((l) => [l.code, l]));
      } catch {
        /* none */
      }
    }
  }, []);

  const loadPicks = useCallback(async () => {
    try {
      setPicks((await api<{ tasks: PickRow[] }>("/api/picks")).tasks.filter((x) => x.status === "OPEN"));
    } catch {
      /* offline */
    }
  }, []);
  const loadCounts = useCallback(async () => {
    try {
      setCounts((await api<{ counts: CountRow[] }>("/api/counts")).counts.filter((c) => c.status === "OPEN"));
    } catch {
      /* offline */
    }
  }, []);

  // ── sync of queued scans (in scan order) ──
  const syncing$ = useRef(false);
  const flush = useCallback(async () => {
    if (syncing$.current || !navigator.onLine) return;
    syncing$.current = true;
    setSyncing(true);
    try {
      for (;;) {
        const pending = (await scanQueue.pending(user.id)).slice(0, 100);
        if (!pending.length) break;
        let res: { results: (ScanResponse & { httpStatus?: number })[] };
        try {
          res = await api("/api/scan/batch", { method: "POST", json: { ops: pending.map((p) => ({ ...p.op, deferred: true })) } });
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) setNeedLogin(true);
          break; // still offline / server unreachable — the scans stay pending
        }
        for (const r of res.results) {
          const q = pending.find((p) => p.opId === r.opId);
          if (q) await scanQueue.put({ ...q, status: statusOf(r), response: r, attempts: q.attempts + 1, updatedAt: Date.now() });
        }
        const conflicts = res.results.filter((r) => r.result === "CONFLICT").length;
        const errors = res.results.filter((r) => r.result === "ERROR").length;
        if (conflicts || errors) {
          feedback("warn");
          setResult({ kind: "warn", title: `סונכרנו ${res.results.length} סריקות`, lines: [`${errors} נכשלו · ${conflicts} דורשות טיפול — ראו ברשימה`] });
        }
      }
    } finally {
      syncing$.current = false;
      setSyncing(false);
      await refreshLog();
    }
  }, [refreshLog, user.id]);

  useEffect(() => {
    void refreshLog();
    void loadLocations();
    void scanQueue.prune().catch(() => undefined);
    setOnline(navigator.onLine);
    const on = () => {
      setOnline(true);
      void flush();
      void loadLocations();
    };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const timer = window.setInterval(() => void flush(), 15_000);
    void flush();
    // keep the handheld's screen on while scanning (where supported)
    let lock: { release: () => Promise<void> } | null = null;
    (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock
      ?.request("screen")
      .then((l) => (lock = l))
      .catch(() => undefined);
    // offline reload of the scanner page in production builds
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") void navigator.serviceWorker.register("/scanner-sw.js", { scope: "/scanner" }).catch(() => undefined);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      window.clearInterval(timer);
      void lock?.release().catch(() => undefined);
    };
  }, [flush, loadLocations, refreshLog]);

  useEffect(() => {
    if (mode === "PICK") void loadPicks();
    if (mode === "COUNT") void loadCounts();
  }, [mode, loadPicks, loadCounts]);

  const setMode = (m: ScanMode) => {
    setModeState(m);
    if (m !== "STORE" && m !== "TRANSFER" && m !== "COUNT") setActive(null);
    setResult({ kind: "ok", title: `מצב ${t.scanMode[m]}`, lines: [m === "STORE" || m === "TRANSFER" ? "סרקו ברקוד מדף" : m === "COUNT" ? "בחרו ספירה וסרקו מיקום" : "סרקו ברקוד ספר"] });
  };

  // ── the scan pipeline ──
  const onScan = useCallback(
    async (raw: string) => {
      const code = raw.trim();
      if (!code || debounce(code)) return;
      const parsed = classifyCode(code);
      const { mode: m, active: loc, count: cnt } = stateRef.current;

      if (parsed.type === "COMMAND") {
        if (!allowedModes.includes(parsed.mode)) {
          feedback("error");
          setResult({ kind: "error", title: "אין לך הרשאה למצב זה", lines: [t.scanMode[parsed.mode]] });
        } else {
          feedback("ok");
          setMode(parsed.mode);
        }
        return;
      }
      if (m === "COUNT" && !cnt) {
        feedback("error");
        setResult({ kind: "error", title: "בחרו או התחילו ספירה", lines: [] });
        return;
      }

      // a shelf scan sets the active location immediately when the code is known on the device
      const cachedLoc = parsed.type === "LOCATION" ? locCache.current.get(parsed.value) : undefined;
      const op: ScanOpInput = {
        opId: crypto.randomUUID(),
        mode: m,
        code,
        contextLocationId: parsed.type === "LOCATION" ? null : (loc?.id ?? null),
        countSessionId: cnt?.id ?? null,
        clientAt: new Date().toISOString(),
        deviceLabel: navigator.userAgent.slice(0, 100),
      };
      const entry: QueuedScan = { opId: op.opId, userId: user.id, op, status: "pending", deferred: false, attempts: 0, createdAt: Date.now(), updatedAt: Date.now() };
      await scanQueue.put(entry); // durable before anything is shown

      const queued = async (why: string) => {
        await scanQueue.put({ ...entry, deferred: true, updatedAt: Date.now() });
        if (parsed.type === "LOCATION") {
          if (cachedLoc && m !== "FIND" && m !== "PICK") {
            setActive(cachedLoc);
            feedback("queued");
            setResult({ kind: "queued", title: `מיקום פעיל: ${cachedLoc.code}`, lines: [cachedLoc.label, why] });
          } else {
            feedback("error");
            setResult({ kind: "error", title: `מיקום ${parsed.value} לא מוכר במכשיר`, lines: ["נדרש חיבור כדי לזהות מיקום חדש", why] });
          }
        } else {
          feedback("queued");
          setResult({ kind: "queued", title: "נשמר במכשיר — ממתין לסנכרון", lines: [code, loc && m !== "FIND" ? `יעד: ${loc.code}` : "", why].filter(Boolean) });
        }
        await refreshLog();
      };

      if (!navigator.onLine) return queued("אין חיבור לאינטרנט");
      try {
        const r = await api<ScanResponse>("/api/scan", { method: "POST", json: op });
        await scanQueue.put({ ...entry, status: statusOf(r), response: r, attempts: 1, updatedAt: Date.now() });
        if (r.activeLocation && (m === "STORE" || m === "TRANSFER" || m === "COUNT")) setActive(r.activeLocation);
        const res = toResult(r);
        feedback(res.kind === "ok" ? "ok" : res.kind === "error" ? "error" : "warn");
        setResult(res);
        if (m === "PICK" && r.result === "OK") void loadPicks();
        await refreshLog();
        void flush();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setNeedLogin(true);
          return queued("נדרשת התחברות מחדש");
        }
        if (err instanceof ApiError && err.status > 0) {
          await scanQueue.put({ ...entry, status: "error", response: { opId: op.opId, result: "ERROR", message: err.message, codeType: "UNKNOWN" }, attempts: 1, updatedAt: Date.now() });
          feedback("error");
          setResult({ kind: "error", title: err.status === 403 ? "אין לך הרשאה לפעולה זו" : err.message, lines: [code] });
          await refreshLog();
          return;
        }
        return queued("השרת לא זמין");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debounce, flush, loadPicks, refreshLog, user.id, perms.operate],
  );

  // device API adapter (future native wrapper) + keeping the wedge input focused
  useEffect(() => attachAdapter((c) => void onScan(c)), [onScan]);
  useEffect(() => {
    const keep = window.setInterval(() => {
      if (!keyboard && document.activeElement !== input.current && !document.querySelector("dialog[open]") && !(document.activeElement instanceof HTMLSelectElement)) input.current?.focus();
    }, 400);
    return () => window.clearInterval(keep);
  }, [keyboard]);

  async function startCount(zoneId: string | null) {
    try {
      const r = await api<{ count: { id: string } }>("/api/counts", { method: "POST", json: { zoneId } });
      setCount({ id: r.count.id, zone: zones.find((z) => z.id === zoneId)?.name ?? null });
      setActive(null);
      feedback("ok");
      setResult({ kind: "ok", title: "ספירה התחילה", lines: ["סרקו מיקום ואז את כל הספרים בו"] });
      void loadCounts();
    } catch (err) {
      feedback("error");
      setResult({ kind: "error", title: err instanceof Error ? err.message : "שגיאה", lines: [] });
    }
  }
  async function submitCount() {
    if (!count) return;
    try {
      await api(`/api/counts/${count.id}/submit`, { method: "POST" });
      setCount(null);
      setActive(null);
      feedback("ok");
      setResult({ kind: "ok", title: "הספירה הוגשה לבדיקת מנהל", lines: ["מיקומים לא ישתנו לפני אישור הפערים"] });
    } catch (err) {
      feedback("error");
      setResult({ kind: "error", title: err instanceof Error ? err.message : "שגיאה", lines: [] });
    }
  }

  const pending = log.filter((l) => l.status === "pending").length;
  const tone = result ? { ok: "bg-[#0f5132] ring-[#2fbf71]", warn: "bg-[#5b4210] ring-[#f0b429]", error: "bg-[#6b1513] ring-[#ff5d52]", queued: "bg-[#3d3410] ring-[#d9b84a]" }[result.kind] : "bg-studio-2 ring-studio-rule";
  const Icon = result ? { ok: Check, warn: TriangleAlert, error: CircleAlert, queued: Clock }[result.kind] : MapPin;

  return (
    <div className="flex min-h-dvh flex-col bg-studio text-studio-text" onClick={() => !keyboard && input.current?.focus()}>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-studio-rule px-3">
        <span className="text-[14px] font-semibold">מסופון</span>
        <span className="truncate text-[12.5px] text-studio-muted">{user.name}</span>
        <div className="ms-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void flush()}
            className={cn("flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12.5px]", online ? "bg-studio-3" : "bg-[#5b4210] text-[#ffd98a]")}
            aria-label={online ? "מחובר — סנכרון" : "אין חיבור"}
          >
            {online ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
            {pending > 0 ? <span className="num">{pending} ממתינות</span> : online ? "מחובר" : "לא מקוון"}
            {syncing && <RefreshCw className="size-3.5 animate-spin" />}
          </button>
          <Link href="/" className="flex size-8 items-center justify-center rounded-full bg-studio-3" aria-label="יציאה למערכת" title="למערכת">
            <LogOut className="size-3.5" />
          </Link>
        </div>
      </header>

      {needLogin && (
        <a href="/login?next=/scanner" className="bg-[#6b1513] px-3 py-2 text-center text-[13px]">
          פג תוקף ההתחברות — הסריקות נשמרות במכשיר. לחצו כאן להתחברות מחדש.
        </a>
      )}

      <nav className="grid shrink-0 grid-cols-5 gap-1 p-2" aria-label="מצב עבודה">
        {SCAN_MODES.map((m) => (
          <button
            key={m}
            type="button"
            disabled={!allowedModes.includes(m)}
            onClick={() => setMode(m)}
            aria-pressed={mode === m}
            className={cn("h-11 rounded-lg text-[14px] font-semibold disabled:opacity-30", mode === m ? "bg-studio-text text-studio" : "bg-studio-3 text-studio-text")}
          >
            {t.scanMode[m]}
          </button>
        ))}
      </nav>

      {(mode === "STORE" || mode === "TRANSFER" || mode === "COUNT") && (
        <div className="mx-2 flex items-center gap-2 rounded-lg bg-studio-2 px-3 py-2.5 ring-1 ring-studio-rule" data-testid="active-location">
          <MapPin className="size-5 shrink-0 text-studio-muted" />
          {active ? (
            <div className="min-w-0">
              <div className="num font-mono text-[20px] font-bold leading-tight">{active.code}</div>
              <div className="truncate text-[12px] text-studio-muted">{active.label}</div>
            </div>
          ) : (
            <div className="text-[15px] text-studio-muted">{mode === "TRANSFER" ? "סרקו מיקום יעד" : "סרקו ברקוד מדף"}</div>
          )}
          {active && (
            <button type="button" className="ms-auto rounded-md px-2 py-1 text-[12px] text-studio-muted hover:bg-studio-3" onClick={() => setActive(null)}>
              ניקוי
            </button>
          )}
        </div>
      )}

      {mode === "COUNT" && (
        <div className="mx-2 mt-2 rounded-lg bg-studio-2 px-3 py-2.5 text-[13px] ring-1 ring-studio-rule">
          {count ? (
            <div className="flex items-center gap-2">
              <span>ספירה פעילה{count.zone ? ` · ${count.zone}` : ""}</span>
              <button type="button" onClick={() => void submitCount()} className="ms-auto rounded-md bg-studio-3 px-3 py-1.5 font-medium">
                הגשת הספירה
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {counts.map((c) => (
                <button key={c.id} type="button" onClick={() => setCount({ id: c.id, zone: c.zone })} className="block w-full rounded-md bg-studio-3 px-3 py-2 text-start">
                  המשך ספירה{c.zone ? ` · ${c.zone}` : " · כל המחסן"} · <span className="num">{c.entries}</span> נספרו
                </button>
              ))}
              <div className="flex flex-wrap gap-1.5">
                <span className="w-full text-studio-muted">ספירה חדשה:</span>
                {zones.map((z) => (
                  <button key={z.id} type="button" onClick={() => void startCount(z.id)} className="rounded-md bg-studio-3 px-3 py-1.5">
                    {z.name}
                  </button>
                ))}
                <button type="button" onClick={() => void startCount(null)} className="rounded-md bg-studio-3 px-3 py-1.5">
                  כל המחסן
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <section className={cn("mx-2 mt-2 rounded-xl px-4 py-4 ring-2 transition-colors", tone)} aria-live="assertive" data-testid="scan-result" data-kind={result?.kind ?? "idle"}>
        <div className="flex items-start gap-3">
          <Icon className="mt-0.5 size-7 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[19px] font-bold leading-snug">{result?.title ?? `מצב ${t.scanMode[mode]} — מוכן לסריקה`}</div>
            {result?.lines.map((l, i) => (
              <div key={i} className="mt-0.5 truncate text-[14.5px] opacity-90">
                {l}
              </div>
            ))}
          </div>
          {result?.item?.thumbUrl && <img src={result.item.thumbUrl} alt="" className="size-16 shrink-0 rounded-md object-cover ring-1 ring-white/20" />}
        </div>
        {mode === "FIND" && result?.item && (
          <dl className="mt-3 grid grid-cols-[96px_1fr] gap-x-2 gap-y-1 border-t border-white/15 pt-3 text-[13.5px]">
            <dt className="opacity-70">מצב מחסן</dt>
            <dd>{t.physicalStatus[result.item.physicalStatus as keyof typeof t.physicalStatus]}</dd>
            <dt className="opacity-70">מצב מסחרי</dt>
            <dd>{t.commercialStatus[result.item.commercialStatus as keyof typeof t.commercialStatus]}</dd>
            <dt className="opacity-70">שיוך</dt>
            <dd>{result.item.assignment ? `${result.item.assignment.house} · קטלוג ${result.item.assignment.catalogNumber} · פריט ${result.item.assignment.lotNumber}` : "—"}</dd>
            <dt className="opacity-70">צילום</dt>
            <dd>{t.photoStatus[result.item.photoStatus as keyof typeof t.photoStatus]}</dd>
            <dt className="opacity-70">פעולות</dt>
            <dd>{result.item.allowed.length ? result.item.allowed.join(" · ") : "אין"}</dd>
          </dl>
        )}
      </section>

      {mode === "PICK" && (
        <section className="mx-2 mt-2 rounded-lg bg-studio-2 ring-1 ring-studio-rule">
          <div className="flex items-center justify-between px-3 py-2 text-[13px]">
            <span className="font-semibold">
              משימות ליקוט · <span className="num">{picks.length}</span>
            </span>
            <span className="text-studio-muted">לפי סדר מדפים</span>
          </div>
          <ol className="max-h-56 divide-y divide-studio-rule overflow-y-auto text-[14px]">
            {picks.map((p, i) => (
              <li key={p.id} className={cn("flex items-center gap-3 px-3 py-2", i === 0 && "bg-studio-3")}>
                <span className="num w-28 shrink-0 font-mono font-semibold">{p.location?.code ?? "ללא מיקום"}</span>
                <span className="min-w-0 truncate">
                  <span className="num font-mono text-[12px] text-studio-muted">{p.item.inventoryNumber}</span> {p.item.title}
                </span>
              </li>
            ))}
            {picks.length === 0 && <li className="px-3 py-3 text-studio-muted">אין משימות ליקוט פתוחות</li>}
          </ol>
        </section>
      )}

      <form
        className="mx-2 mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const v = value;
          setValue("");
          void onScan(v);
        }}
      >
        <input
          ref={input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode={keyboard ? "text" : "none"}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          dir="ltr"
          aria-label="קלט סורק"
          placeholder={keyboard ? "הקלידו ברקוד ולחצו Enter" : "ממתין לסריקה…"}
          className="h-11 min-w-0 flex-1 rounded-lg bg-studio-2 px-3 font-mono text-[16px] text-studio-text ring-1 ring-studio-rule placeholder:text-studio-muted focus:outline-none focus:ring-2 focus:ring-studio-muted"
          autoFocus
        />
        <button
          type="button"
          onClick={() => {
            setKeyboard((k) => !k);
            requestAnimationFrame(() => input.current?.focus());
          }}
          aria-pressed={keyboard}
          className={cn("flex size-11 shrink-0 items-center justify-center rounded-lg", keyboard ? "bg-studio-text text-studio" : "bg-studio-3")}
          aria-label="הקלדה ידנית"
          title="הקלדה ידנית"
        >
          <Keyboard className="size-5" />
        </button>
      </form>

      <section className="mx-2 mb-3 mt-3 flex-1">
        <div className="mb-1 px-1 text-[12px] text-studio-muted">סריקות אחרונות</div>
        <ul className="divide-y divide-studio-rule overflow-hidden rounded-lg bg-studio-2 text-[13px] ring-1 ring-studio-rule" data-testid="scan-log">
          {log.slice(0, 25).map((s) => (
            <li key={s.opId} className="flex items-center gap-2 px-3 py-1.5" data-status={s.status}>
              <span className="w-14 shrink-0 text-[11.5px] text-studio-muted">{t.scanMode[s.op.mode]}</span>
              <span className="num min-w-0 flex-1 truncate font-mono">{s.op.code}</span>
              <span className="hidden min-w-0 max-w-[40%] truncate text-[11.5px] text-studio-muted sm:inline">{s.response?.message}</span>
              <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", STATUS_TONE[s.status])}>{STATUS_LABEL[s.status]}</span>
            </li>
          ))}
          {log.length === 0 && <li className="px-3 py-3 text-studio-muted">עדיין לא נסרק דבר</li>}
        </ul>
        {perms.manage && (
          <p className="mt-2 px-1 text-[12px] text-studio-muted">
            ברקודי פקודה להדפסה:{" "}
            <Link href="/labels/commands" className="underline">
              תוויות מצבי עבודה
            </Link>
          </p>
        )}
      </section>
    </div>
  );
}
