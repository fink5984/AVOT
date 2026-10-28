"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, BookDown, BookUp, Camera, Check, CircleAlert, ClipboardCheck, Clock, Keyboard, Library, MapPin, MoveRight, RefreshCw, Search, Smartphone, TriangleAlert, Warehouse, WifiOff, X } from "lucide-react";
import { SCAN_MODES, classifyCode, type ScanMode, type ScanOpInput, type ScanResponse } from "@avot/shared";
import { t } from "@/i18n";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { attachAdapter, createDebouncer, feedback } from "@/lib/scanner/input";
import { scanQueue, type QueuedScan, type ScanStatus } from "@/lib/scanner/queue";
import { CameraPane } from "@/components/scanner/camera-pane";

/*
 * The phone scanner. A small, light work app: five actions, one instruction at a time, the camera, the active
 * shelf, and a short confirmation after each scan. The history of scans is NOT shown here — it is still stored
 * (device queue + server log) and managers read it in the warehouse area of the desktop system (/scans).
 */

interface Loc {
  id: string;
  code: string;
  label: string;
}
type Kind = "ok" | "warn" | "error" | "queued";
interface Result {
  id: number;
  kind: Kind;
  text: string;
  /** FIND keeps its details on screen; other successes disappear by themselves */
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

const LS_KEY = "avot.scanner";
const COUNT_KEY = "avot.scanner.ok";

type Intent = "TEMP_OUT" | "FINAL_OUT" | undefined;
interface Activity {
  key: string;
  mode: ScanMode;
  intent?: Intent;
  title: string;
  short: string;
  icon: React.ComponentType<{ className?: string }>;
}
const ACTIVITIES: Record<string, Activity> = {
  STORE: { key: "STORE", mode: "STORE", title: "הכנסת ספר למחסן", short: "הכנסת ספר", icon: BookDown },
  TEMP_OUT: { key: "TEMP_OUT", mode: "PICK", intent: "TEMP_OUT", title: "הוצאה זמנית", short: "הוצאה זמנית", icon: BookUp },
  PICK: { key: "PICK", mode: "PICK", title: "ליקוט להזמנה", short: "ליקוט להזמנה", icon: BookUp },
  FINAL_OUT: { key: "FINAL_OUT", mode: "PICK", intent: "FINAL_OUT", title: "הוצאה סופית", short: "הוצאה סופית", icon: BookUp },
  TRANSFER: { key: "TRANSFER", mode: "TRANSFER", title: "העברת ספר בין מדפים", short: "העברת ספר", icon: MoveRight },
  FIND: { key: "FIND", mode: "FIND", title: "איתור ספר", short: "איתור ספר", icon: Search },
  COUNT: { key: "COUNT", mode: "COUNT", title: "ספירת מלאי", short: "ספירת מלאי", icon: ClipboardCheck },
};
const activityOf = (mode: ScanMode, intent: Intent) => Object.values(ACTIVITIES).find((a) => a.mode === mode && a.intent === intent) ?? ACTIVITIES.STORE!;

/** "מחסן 1 · עמודה 5 · מדף 5" → "מדף 5" */
const shelfOf = (label: string | undefined | null) => (label ?? "").split(" · ").find((s) => s.startsWith("מדף")) ?? label ?? "";

function statusOf(r: ScanResponse): ScanStatus {
  return r.result === "OK" || r.result === "NOOP" ? "synced" : r.result === "CONFLICT" ? "conflict" : "error";
}

/** One short sentence per outcome, in the worker's words. */
function sentence(r: ScanResponse, mode: ScanMode, intent: Intent): { kind: Kind; text: string } {
  const title = r.item?.title ?? "";
  const shelf = shelfOf(r.activeLocation?.label ?? r.item?.location?.label);
  if (r.result === "ERROR" || r.result === "CONFLICT") return { kind: "error", text: r.message };
  if (r.result === "NOOP") return { kind: "warn", text: title && shelf ? `${title} כבר ב${shelf}` : r.message };
  if (r.warning) return { kind: "warn", text: title ? `${title} · ${r.message}` : r.message };
  if (r.codeType === "LOCATION") return { kind: "ok", text: `${shelf || r.message} נבחר` };
  if (mode === "STORE") return { kind: "ok", text: `${title} נקלט ב${shelf}` };
  if (mode === "TRANSFER") return { kind: "ok", text: `${title} הועבר ל${shelf}` };
  if (mode === "COUNT") return { kind: "ok", text: `${title} נספר` };
  if (mode === "PICK" && intent === "TEMP_OUT") return { kind: "ok", text: `${title} הוצא זמנית` };
  if (mode === "PICK" && intent === "FINAL_OUT") return { kind: "ok", text: `${title} הוצא סופית` };
  if (mode === "PICK") return { kind: "ok", text: `${title} לוקט${r.pick ? ` · נותרו ${r.pick.remaining}` : ""}` };
  if (mode === "FIND") return { kind: "ok", text: title };
  return { kind: "ok", text: r.message };
}

/** Phones and tablets: a coarse (touch) pointer. A desktop with a mouse is not — whatever its window width. */
function useIsHandheld() {
  const [state, setState] = useState<"unknown" | "handheld" | "desktop">("unknown");
  useEffect(() => {
    const forced = new URLSearchParams(window.location.search).get("mobile") === "1" || sessionStorage.getItem("avot.scanner.force") === "1";
    if (forced) sessionStorage.setItem("avot.scanner.force", "1");
    const touch = navigator.maxTouchPoints > 0;
    const coarse = window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(hover: none)").matches;
    setState(forced || (touch && coarse) ? "handheld" : "desktop");
  }, []);
  return state;
}

export function ScannerApp(props: { user: { id: string; name: string }; perms: { operate: boolean; manage: boolean } }) {
  const device = useIsHandheld();
  if (device === "unknown") return <div className="min-h-dvh bg-canvas" />;
  if (device === "desktop") return <DesktopNotice />;
  return <Scanner {...props} />;
}

function DesktopNotice() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas p-6 text-ink">
      <div className="w-full max-w-md rounded-2xl bg-paper p-7 text-center shadow-card ring-1 ring-rule">
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-stone">
          <Smartphone className="size-6 text-ink-2" />
        </span>
        <h1 className="mt-4 text-[20px] font-semibold">המסופון מיועד לשימוש בטלפון</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-muted">במחשב אפשר לבצע את כל פעולות המחסן דרך המלאי ומסך המחסן.</p>
        <div className="mt-6 grid grid-cols-2 gap-2.5">
          <Link href="/inventory" className="flex h-11 items-center justify-center gap-2 rounded-xl bg-ink text-[14px] font-medium text-paper">
            <Library className="size-4" /> פתח מלאי
          </Link>
          <Link href="/warehouse" className="flex h-11 items-center justify-center gap-2 rounded-xl bg-paper text-[14px] font-medium text-ink ring-1 ring-rule-strong">
            <Warehouse className="size-4" /> פתח מחסן
          </Link>
        </div>
      </div>
    </main>
  );
}

function Scanner({ user, perms }: { user: { id: string; name: string }; perms: { operate: boolean; manage: boolean } }) {
  const [mode, setModeState] = useState<ScanMode>(perms.operate ? "STORE" : "FIND");
  const [intent, setIntent] = useState<Intent>(undefined);
  const [view, setView] = useState<"home" | "work">("home");
  const [outMenu, setOutMenu] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [active, setActive] = useState<Loc | null>(null);
  const [count, setCount] = useState<{ id: string; zone: string | null } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [okCount, setOkCount] = useState(0);
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);
  const [picks, setPicks] = useState<PickRow[]>([]);
  const [counts, setCounts] = useState<CountRow[]>([]);
  const [zones, setZones] = useState<{ id: string; name: string }[]>([]);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const resultId = useRef(0);
  const locCache = useRef<Map<string, Loc>>(new Map());
  const debounce = useMemo(() => createDebouncer(700), []);
  // codes whose request is still running: the same code is never sent twice at once (a new opId is made only for a real new scan)
  const inflight = useRef(new Set<string>());
  const stateRef = useRef<{ mode: ScanMode; active: Loc | null; count: { id: string; zone: string | null } | null; intent: Intent }>({ mode, active, count, intent });
  stateRef.current = { mode, active, count, intent };

  const allowedModes = SCAN_MODES.filter((m) => m === "FIND" || perms.operate);

  const show = useCallback((kind: Kind, text: string, item?: ScanResponse["item"]) => {
    setResult({ id: ++resultId.current, kind, text, item });
  }, []);

  // ── persisted UI state survives reloads ──
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as { mode?: ScanMode; active?: Loc; count?: { id: string; zone: string | null } };
      if (s.mode && allowedModes.includes(s.mode)) setModeState(s.mode);
      if (s.active) setActive(s.active);
      if (s.count) setCount(s.count);
      setOkCount(Number(sessionStorage.getItem(COUNT_KEY) ?? 0) || 0);
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
  useEffect(() => {
    try {
      sessionStorage.setItem(COUNT_KEY, String(okCount));
    } catch {
      /* private mode */
    }
  }, [okCount]);

  // successes disappear by themselves; problems stay until the worker closes them (or the next scan succeeds)
  useEffect(() => {
    if (!result || result.kind === "error") return;
    if (result.item && mode === "FIND") return;
    const timer = setTimeout(() => setResult((r) => (r && r.id === result.id ? null : r)), result.kind === "ok" ? 3200 : 5500);
    return () => clearTimeout(timer);
  }, [result, mode]);

  const refreshPending = useCallback(async () => setPending((await scanQueue.pending(user.id)).length), [user.id]);

  // ── location cache: lets a shelf scan work while offline ──
  const loadLocations = useCallback(async () => {
    try {
      const r = await api<{ warehouses: { name: string; zones: { id: string; name: string; code: string; shelves: { code: string; locations: { id: string; code: string; active: boolean; aliases: { alias: string }[] }[] }[] }[] }[] }>("/api/warehouse");
      const map = new Map<string, Loc>();
      const zs: { id: string; name: string }[] = [];
      const plain = (c: string) => (/^\d+$/.test(c) ? String(Number(c)) : c);
      for (const w of r.warehouses)
        for (const z of w.zones) {
          zs.push({ id: z.id, name: `${w.name} · ${z.name}` });
          for (const s of z.shelves)
            for (const l of s.locations)
              if (l.active) {
                const loc = { id: l.id, code: l.code, label: [w.name, z.name || `עמודה ${plain(z.code)}`, `מדף ${plain(s.code)}`].join(" · ") };
                map.set(l.code, loc);
                // printed labels from before shelves lost their cell still scan (also offline)
                for (const a of l.aliases) map.set(a.alias, loc);
              }
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
        const queue = (await scanQueue.pending(user.id)).slice(0, 100);
        if (!queue.length) break;
        let res: { results: (ScanResponse & { httpStatus?: number })[] };
        try {
          res = await api("/api/scan/batch", { method: "POST", json: { ops: queue.map((p) => ({ ...p.op, deferred: true })) } });
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) setNeedLogin(true);
          break; // still offline / server unreachable — the scans stay pending
        }
        for (const r of res.results) {
          const q = queue.find((p) => p.opId === r.opId);
          if (q) await scanQueue.put({ ...q, status: statusOf(r), response: r, attempts: q.attempts + 1, updatedAt: Date.now() });
        }
        const conflicts = res.results.filter((r) => r.result === "CONFLICT").length;
        const errors = res.results.filter((r) => r.result === "ERROR").length;
        const good = res.results.length - conflicts - errors;
        if (good > 0) setOkCount((n) => n + good);
        if (conflicts || errors) {
          feedback("warn");
          show("error", `סונכרנו ${res.results.length} סריקות: ${errors} נכשלו, ${conflicts} דורשות טיפול. המנהל יראה אותן ביומן המחסן.`);
        }
      }
    } finally {
      syncing$.current = false;
      setSyncing(false);
      await refreshPending();
    }
  }, [refreshPending, show, user.id]);

  useEffect(() => {
    void refreshPending();
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
    // keep the screen on while scanning (where supported)
    let lock: { release: () => Promise<void> } | null = null;
    (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock
      ?.request("screen")
      .then((l) => (lock = l))
      .catch(() => undefined);
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") void navigator.serviceWorker.register("/scanner-sw.js", { scope: "/scanner" }).catch(() => undefined);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      window.clearInterval(timer);
      void lock?.release().catch(() => undefined);
    };
  }, [flush, loadLocations, refreshPending]);

  useEffect(() => {
    if (mode === "PICK" && !intent) void loadPicks();
    if (mode === "COUNT") void loadCounts();
  }, [mode, intent, loadPicks, loadCounts]);

  const startActivity = (a: Activity) => {
    setIntent(a.intent);
    setModeState(a.mode);
    // every activity starts clean: a shelf left over from the previous activity is never used silently
    setActive(null);
    setResult(null);
    setOutMenu(false);
    setView("work");
  };
  // command barcodes (CMD-FIND …) switch the activity without leaving the camera
  const setMode = (m: ScanMode) => {
    setIntent(undefined);
    setModeState(m);
    if (m !== "STORE" && m !== "TRANSFER" && m !== "COUNT") setActive(null);
    setView("work");
    show("ok", `${activityOf(m, undefined).short}`);
  };

  // ── the scan pipeline ──
  const onScan = useCallback(
    async (raw: string) => {
      const code = raw.trim();
      if (!code || debounce(code) || inflight.current.has(code)) return;
      inflight.current.add(code);
      try {
        await scanOneRef.current(code);
      } finally {
        inflight.current.delete(code);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debounce],
  );

  const scanOneRef = useRef<(code: string) => Promise<void>>(async () => undefined);
  const scanOne = useCallback(
    async (code: string) => {
      const parsed = classifyCode(code);
      const { mode: m, active: loc, count: cnt, intent: why } = stateRef.current;

      if (parsed.type === "COMMAND") {
        if (!allowedModes.includes(parsed.mode)) {
          feedback("error");
          show("error", "אין לך הרשאה לפעולה זו");
        } else {
          feedback("ok");
          setMode(parsed.mode);
        }
        return;
      }
      if (m === "COUNT" && !cnt) {
        feedback("error");
        show("error", "בחרו ספירה או התחילו ספירה חדשה");
        return;
      }

      const cachedLoc = parsed.type === "LOCATION" ? locCache.current.get(parsed.value) : undefined;
      const op: ScanOpInput = {
        opId: crypto.randomUUID(),
        mode: m,
        code,
        contextLocationId: parsed.type === "LOCATION" ? null : (loc?.id ?? null),
        countSessionId: cnt?.id ?? null,
        clientAt: new Date().toISOString(),
        deviceLabel: navigator.userAgent.slice(0, 100),
        ...(m === "PICK" && why ? { intent: why } : {}),
      };
      const entry: QueuedScan = { opId: op.opId, userId: user.id, op, status: "pending", deferred: false, attempts: 0, createdAt: Date.now(), updatedAt: Date.now() };
      await scanQueue.put(entry); // durable before anything is shown

      const queued = async (why2: string) => {
        await scanQueue.put({ ...entry, deferred: true, updatedAt: Date.now() });
        if (parsed.type === "LOCATION") {
          if (cachedLoc && m !== "FIND" && m !== "PICK") {
            setActive(cachedLoc);
            feedback("queued");
            show("queued", `${shelfOf(cachedLoc.label)} נבחר · ${why2}`);
          } else {
            feedback("error");
            show("error", `המדף ${parsed.value} לא מוכר במכשיר. נדרש חיבור כדי לזהות מדף חדש.`);
          }
        } else {
          feedback("queued");
          show("queued", `נשמר במכשיר — ממתין לסנכרון${loc && m !== "FIND" ? ` · ${shelfOf(loc.label)}` : ""}`);
        }
        await refreshPending();
      };

      if (!navigator.onLine) return queued("אין חיבור");
      try {
        const r = await api<ScanResponse>("/api/scan", { method: "POST", json: op });
        await scanQueue.put({ ...entry, status: statusOf(r), response: r, attempts: 1, updatedAt: Date.now() });
        if (r.activeLocation && (m === "STORE" || m === "TRANSFER" || m === "COUNT")) setActive(r.activeLocation);
        const s = sentence(r, m, why);
        feedback(s.kind === "ok" ? "ok" : s.kind === "error" ? "error" : "warn");
        show(s.kind, s.text, m === "FIND" ? r.item : undefined);
        if (r.result === "OK" && r.codeType !== "LOCATION") setOkCount((n) => n + 1);
        if (m === "PICK" && !why && r.result === "OK") void loadPicks();
        await refreshPending();
        void flush();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setNeedLogin(true);
          return queued("נדרשת התחברות");
        }
        if (err instanceof ApiError && err.status > 0) {
          await scanQueue.put({ ...entry, status: "error", response: { opId: op.opId, result: "ERROR", message: err.message, codeType: "UNKNOWN" }, attempts: 1, updatedAt: Date.now() });
          feedback("error");
          show("error", err.status === 403 ? "אין לך הרשאה לפעולה זו" : err.message);
          await refreshPending();
          return;
        }
        return queued("השרת לא זמין");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debounce, flush, loadPicks, refreshPending, show, user.id, perms.operate],
  );
  scanOneRef.current = scanOne;

  // device API adapter (native wrappers) + the wedge input of a hardware scanner
  useEffect(() => attachAdapter((c) => void onScan(c)), [onScan]);
  useEffect(() => {
    const keep = window.setInterval(() => {
      if (view === "work" && !keyboard && document.activeElement !== input.current && !document.querySelector("dialog[open]") && !(document.activeElement instanceof HTMLSelectElement)) input.current?.focus();
    }, 400);
    return () => window.clearInterval(keep);
  }, [keyboard, view]);

  async function startCount(zoneId: string | null) {
    try {
      const r = await api<{ count: { id: string } }>("/api/counts", { method: "POST", json: { zoneId } });
      setCount({ id: r.count.id, zone: zones.find((z) => z.id === zoneId)?.name ?? null });
      setActive(null);
      feedback("ok");
      show("ok", "הספירה התחילה");
      void loadCounts();
    } catch (err) {
      feedback("error");
      show("error", err instanceof Error ? err.message : "שגיאה");
    }
  }
  async function submitCount() {
    if (!count) return;
    try {
      await api(`/api/counts/${count.id}/submit`, { method: "POST" });
      setCount(null);
      setActive(null);
      feedback("ok");
      show("ok", "הספירה הוגשה לאישור מנהל. מיקומים לא ישתנו לפני האישור.");
    } catch (err) {
      feedback("error");
      show("error", err instanceof Error ? err.message : "שגיאה");
    }
  }

  const act = activityOf(mode, intent);
  // exactly what to scan next — one instruction
  const step =
    mode === "STORE"
      ? active
        ? "סרוק ספר"
        : "סרוק מדף"
      : mode === "TRANSFER"
        ? active
          ? "סרוק את הספרים שמועברים"
          : "סרוק את מדף היעד"
        : mode === "COUNT"
          ? !count
            ? "בחרו ספירה"
            : active
              ? "סרוק ספרים"
              : "סרוק מדף"
          : "סרוק ספר";
  const stepHint =
    mode === "STORE" && active
      ? "אפשר להחליף מדף בכל רגע — סרקו מדף אחר"
      : mode === "TRANSFER" && !active
        ? "אין צורך לסרוק את מדף המקור"
        : mode === "FIND"
          ? "יוצגו התמונה והמיקום"
          : mode === "PICK" && !intent
            ? "לפי סדר המדפים"
            : null;

  // ── sync chip: short, one place ──
  const chip = !online ? (
    <span className="flex h-8 items-center gap-1.5 rounded-full bg-warn-soft px-2.5 text-[12.5px] font-medium text-warn">
      <WifiOff className="size-3.5" />
      לא מקוון{pending > 0 ? ` · ${pending} ממתינות` : ""}
    </span>
  ) : pending > 0 ? (
    <button type="button" onClick={() => void flush()} className="flex h-8 items-center gap-1.5 rounded-full bg-warn-soft px-2.5 text-[12.5px] font-medium text-warn" aria-label={`${pending} סריקות ממתינות לסנכרון — לחצו לסנכרון`}>
      <Clock className="size-3.5" />
      <span className="num">{pending}</span> ממתינות לסנכרון
      {syncing && <RefreshCw className="size-3.5 animate-spin" />}
    </button>
  ) : (
    <span className="flex h-8 items-center gap-1.5 rounded-full bg-green-soft px-2.5 text-[12.5px] font-medium text-green-2">
      <Check className="size-3.5" />
      מחובר
    </span>
  );

  const header = (
    <header className="flex h-12 shrink-0 items-center gap-2 px-3">
      {view === "work" ? (
        <button type="button" onClick={() => setView("home")} className="flex h-8 items-center gap-1 rounded-full bg-paper ps-2 pe-3 text-[13px] font-medium ring-1 ring-rule" aria-label="חזרה לפעולות">
          <ArrowRight className="size-4" />
          פעולות
        </button>
      ) : (
        <span className="text-[15px] font-semibold">מסופון</span>
      )}
      <span className="min-w-0 truncate text-[13px] text-muted">{view === "work" ? act.title : user.name}</span>
      <div className="ms-auto flex items-center gap-1.5">
        {okCount > 0 && (
          <span className="flex h-8 items-center gap-1 rounded-full bg-paper px-2.5 text-[12.5px] font-medium text-ink-2 ring-1 ring-rule" title="פעולות מוצלחות במכשיר זה" aria-label={`${okCount} פעולות מוצלחות`}>
            <Check className="size-3.5 text-green" />
            <span className="num">{okCount}</span>
          </span>
        )}
        {chip}
      </div>
    </header>
  );
  const loginBanner = needLogin && (
    <a href="/login?next=/scanner" className="mx-3 mb-2 rounded-xl bg-danger-soft px-3 py-2 text-center text-[13px] text-danger">
      פג תוקף ההתחברות — הסריקות נשמרות במכשיר. לחצו להתחברות מחדש.
    </a>
  );

  if (view === "home") {
    const tiles: { title: string; icon: Activity["icon"]; on: () => void; off?: boolean; wide?: boolean }[] = [
      { title: ACTIVITIES.STORE!.short, icon: BookDown, on: () => startActivity(ACTIVITIES.STORE!), off: !perms.operate },
      { title: "הוצאת ספר", icon: BookUp, on: () => setOutMenu(true), off: !perms.operate },
      { title: ACTIVITIES.TRANSFER!.short, icon: MoveRight, on: () => startActivity(ACTIVITIES.TRANSFER!), off: !perms.operate },
      { title: ACTIVITIES.FIND!.short, icon: Search, on: () => startActivity(ACTIVITIES.FIND!) },
      { title: ACTIVITIES.COUNT!.short, icon: ClipboardCheck, on: () => startActivity(ACTIVITIES.COUNT!), off: !perms.operate, wide: true },
    ];
    return (
      <div className="flex min-h-dvh flex-col bg-canvas text-ink">
        {header}
        {loginBanner}
        <main className="grid flex-1 grid-cols-2 content-start gap-2.5 p-3">
          {tiles.map((x) => (
            <button
              key={x.title}
              type="button"
              disabled={x.off}
              onClick={x.on}
              className={cn("flex min-h-[88px] flex-col items-start justify-between rounded-2xl bg-paper p-3.5 text-start shadow-card ring-1 ring-rule transition-colors active:bg-stone disabled:opacity-40", x.wide && "col-span-2 min-h-[72px] flex-row items-center justify-start gap-3")}
            >
              <span className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
                <x.icon className="size-5" />
              </span>
              <span className="text-[16px] font-semibold leading-tight">{x.title}</span>
            </button>
          ))}
          {pending > 0 && <p className="col-span-2 rounded-xl bg-warn-soft px-3 py-2.5 text-[13px] text-warn">{pending} סריקות ממתינות לסנכרון — נשמרות במכשיר ויישלחו כשיחזור החיבור.</p>}
          {perms.manage && (
            <Link href="/scans" className="col-span-2 mt-1 text-center text-[12.5px] text-muted underline">
              יומן סריקות לניהול
            </Link>
          )}
        </main>
        {outMenu && (
          <div className="fixed inset-0 z-40 flex items-end bg-black/35" onClick={() => setOutMenu(false)} role="dialog" aria-label="סוג ההוצאה">
            <div className="w-full space-y-1.5 rounded-t-3xl bg-paper p-3 pb-6 shadow-pop" onClick={(e) => e.stopPropagation()}>
              <h2 className="px-2 pb-1 pt-1 text-[15px] font-semibold">הוצאת ספר</h2>
              {[ACTIVITIES.TEMP_OUT!, ACTIVITIES.PICK!, ACTIVITIES.FINAL_OUT!].map((a) => (
                <button key={a.key} type="button" onClick={() => startActivity(a)} className="block h-12 w-full rounded-xl bg-stone-2 px-4 text-start text-[15px] font-medium active:bg-stone">
                  {a.title}
                </button>
              ))}
              <button type="button" onClick={() => setOutMenu(false)} className="h-11 w-full rounded-xl text-[14px] text-muted">
                ביטול
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  const tone = { ok: "bg-green-soft text-green-2", warn: "bg-warn-soft text-warn", error: "bg-danger-soft text-danger", queued: "bg-warn-soft text-warn" } as const;
  const Icon = result ? { ok: Check, warn: TriangleAlert, error: CircleAlert, queued: Clock }[result.kind] : null;

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink" onClick={() => !keyboard && input.current?.focus()}>
      {header}
      {loginBanner}

      <div className="mx-3 flex items-center gap-3" data-testid="step" aria-live="polite">
        <div className="min-w-0 flex-1">
          <div className="text-[20px] font-bold leading-tight">{step}</div>
          {stepHint && <div className="mt-0.5 text-[12.5px] text-muted">{stepHint}</div>}
        </div>
        <button type="button" onClick={() => setCameraOn((c) => !c)} aria-pressed={cameraOn} aria-label={cameraOn ? "כיבוי המצלמה" : "הפעלת המצלמה"} className={cn("flex size-10 shrink-0 items-center justify-center rounded-full ring-1", cameraOn ? "bg-ink text-paper ring-ink" : "bg-paper text-ink-2 ring-rule")}>
          <Camera className="size-[18px]" />
        </button>
      </div>

      {(mode === "STORE" || mode === "TRANSFER" || mode === "COUNT") && (
        <div className="mx-3 mt-2 flex items-center gap-2.5 rounded-xl bg-paper px-3 py-2 shadow-card ring-1 ring-rule" data-testid="active-location">
          <MapPin className="size-4 shrink-0 text-muted" />
          {active ? (
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14.5px] font-semibold">{active.label}</div>
              <div className="num font-mono text-[11px] text-faint">{active.code}</div>
            </div>
          ) : (
            <div className="text-[13.5px] text-muted">{mode === "TRANSFER" ? "עדיין לא נבחר מדף יעד" : "עדיין לא נבחר מדף"}</div>
          )}
          {active && (
            <button type="button" className="rounded-md px-2 py-1 text-[12px] text-muted" onClick={() => setActive(null)}>
              ניקוי
            </button>
          )}
        </div>
      )}

      {cameraOn && <CameraPane enabled onCode={(c) => void onScan(c)} className="mx-3 mt-2 h-[30dvh] min-h-44 shrink-0" />}

      {/* the answer to the last scan — short; problems stay until closed */}
      <div className="mx-3 mt-2 min-h-11" data-testid="scan-result" data-kind={result?.kind ?? "idle"} aria-live="assertive">
        {result && Icon && (
          <div className={cn("flex items-start gap-2.5 rounded-xl px-3 py-2.5 text-[14px] font-medium", tone[result.kind])}>
            <Icon className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 flex-1 leading-snug">{result.text}</span>
            {result.kind === "error" && (
              <button type="button" onClick={() => setResult(null)} className="-me-1 rounded-md p-1" aria-label="סגירה">
                <X className="size-4" />
              </button>
            )}
          </div>
        )}
      </div>

      {mode === "FIND" && result?.item && (
        <section className="mx-3 mt-1 flex gap-3 rounded-xl bg-paper p-3 shadow-card ring-1 ring-rule">
          {result.item.thumbUrl ? <img src={result.item.thumbUrl} alt="" className="size-20 shrink-0 rounded-lg object-cover ring-1 ring-rule" /> : <div className="size-20 shrink-0 rounded-lg bg-stone" />}
          <div className="min-w-0 flex-1 text-[13px]">
            <div className="text-[15px] font-semibold leading-snug">{result.item.title}</div>
            <div className="mt-1 text-ink-2">{result.item.location ? result.item.location.label : "אין מיקום במחסן"}</div>
            <div className="mt-0.5 text-muted">
              {t.physicalStatus[result.item.physicalStatus as keyof typeof t.physicalStatus]}
              {result.item.assignment ? ` · ${result.item.assignment.house}, קטלוג ${result.item.assignment.catalogNumber}` : ""}
            </div>
          </div>
        </section>
      )}

      {mode === "COUNT" && (
        <div className="mx-3 mt-1 rounded-xl bg-paper px-3 py-2.5 text-[13px] shadow-card ring-1 ring-rule">
          {count ? (
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">ספירה פעילה{count.zone ? ` · ${count.zone}` : ""}</span>
              <button type="button" onClick={() => void submitCount()} className="shrink-0 rounded-lg bg-ink px-3 py-1.5 text-[13px] font-medium text-paper">
                הגשת הספירה
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {counts.map((c) => (
                <button key={c.id} type="button" onClick={() => setCount({ id: c.id, zone: c.zone })} className="block w-full rounded-lg bg-stone-2 px-3 py-2 text-start">
                  המשך ספירה{c.zone ? ` · ${c.zone}` : " · כל המחסן"} · <span className="num">{c.entries}</span> נספרו
                </button>
              ))}
              <div className="flex flex-wrap gap-1.5">
                <span className="w-full text-[12px] text-muted">ספירה חדשה:</span>
                {zones.map((z) => (
                  <button key={z.id} type="button" onClick={() => void startCount(z.id)} className="rounded-lg bg-stone-2 px-3 py-1.5">
                    {z.name}
                  </button>
                ))}
                <button type="button" onClick={() => void startCount(null)} className="rounded-lg bg-stone-2 px-3 py-1.5">
                  כל המחסן
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {mode === "PICK" && !intent && (
        <section className="mx-3 mt-1 rounded-xl bg-paper shadow-card ring-1 ring-rule">
          <div className="px-3 py-2 text-[12.5px] font-semibold">
            משימות ליקוט · <span className="num">{picks.length}</span>
          </div>
          <ol className="max-h-44 divide-y divide-rule overflow-y-auto text-[13px]">
            {picks.slice(0, 20).map((p, i) => (
              <li key={p.id} className={cn("flex items-center gap-2 px-3 py-1.5", i === 0 && "bg-accent-soft/50")}>
                <span className="w-24 shrink-0 truncate font-medium">{shelfOf(p.location?.label) || "ללא מיקום"}</span>
                <span className="min-w-0 truncate text-ink-2">{p.item.title}</span>
              </li>
            ))}
            {picks.length === 0 && <li className="px-3 py-2.5 text-muted">אין משימות ליקוט פתוחות</li>}
          </ol>
        </section>
      )}

      <form
        className="mx-3 mb-3 mt-auto flex gap-2 pt-3"
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
          placeholder={keyboard ? "הקלידו ברקוד ולחצו Enter" : "סורק חיצוני או הקלדה"}
          className="h-10 min-w-0 flex-1 rounded-xl bg-paper px-3 font-mono text-[15px] text-ink ring-1 ring-rule placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ink/30"
        />
        <button
          type="button"
          onClick={() => {
            setKeyboard((k) => !k);
            requestAnimationFrame(() => input.current?.focus());
          }}
          aria-pressed={keyboard}
          className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl ring-1", keyboard ? "bg-ink text-paper ring-ink" : "bg-paper text-ink-2 ring-rule")}
          aria-label="הקלדה ידנית"
          title="הקלדה ידנית"
        >
          <Keyboard className="size-[18px]" />
        </button>
      </form>
    </div>
  );
}
