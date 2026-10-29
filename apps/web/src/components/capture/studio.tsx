"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Battery,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Eye,
  EyeOff,
  Focus,
  Grid3x3,
  Maximize,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  RotateCw,
  ScanLine,
  BookPlus,
  SlidersHorizontal,
} from "lucide-react";
import { PHOTO_CATEGORIES, type BgSample, type CaptureStage, type PhotoCategory } from "@avot/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/field";
import { Kbd } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { downloadOptions } from "@/lib/asset-versions";
import { ImageViewer, assetViewerDetails, type ViewerItem } from "@/components/image-viewer";
import { OutboxIndicator } from "@/components/shell/outbox-indicator";
import { fmt, t } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { outbox, sha256Hex, storageHealth, type OutboxEntry, type StorageHealth } from "@/lib/capture/outbox";
import { uploader } from "@/lib/capture/uploader";
import { DEFAULT_PREFS, isTypingTarget, keyLabel, mergePrefs, playShutter, savePrefs, type CapturePrefs } from "@/lib/capture/prefs";
import { useCaptureProfile } from "@/lib/capture/profile";
import type { CameraControl, CameraDriver, CameraInfo, CaptureContext, ConnectionState } from "@/lib/capture/drivers/types";
import { WebcamDriver } from "@/lib/capture/drivers/webcam";
import { SimulatorDriver } from "@/lib/capture/drivers/simulator";
import { AgentDriver, probeAgent } from "@/lib/capture/drivers/agent";
import type { AssetDto } from "@/server/services/asset-dto";
import type { CaptureLotContext } from "@/server/services/capture-context";
import { CameraPicker, type CameraChoice } from "./camera-picker";
import { Filmstrip, type StripItem } from "./filmstrip";
import { LiveView, type LiveMetrics } from "./live-view";
import { LiveDiagnostics } from "./live-diagnostics";
import { LiveSegmentation, type LiveSegStatus } from "./live-segmentation";
import { CameraSettingsDialog } from "./camera-settings-dialog";
import { PhotoEditorDialog, warningLabel } from "./photo-editor";
import { ControlRow } from "./control-row";
import { ScanOpenDialog } from "./scan-open-dialog";
import { NewBookDialog } from "./new-book-dialog";

interface LocalShot {
  captureId: string;
  lotId: string;
  category: PhotoCategory;
  stage: CaptureStage;
  localUrl?: string;
  thumbUrl?: string | null;
  error?: string | null;
  createdAt: number;
  assetId?: string;
  sequence?: number;
}

const SERVER_STAGE: Record<AssetDto["uploadStatus"], CaptureStage> = {
  PENDING: "QUEUED",
  UPLOADING: "UPLOADING",
  VERIFIED: "VERIFIED",
  FAILED: "NEEDS_ATTENTION",
};

const STATE_LABEL: Record<ConnectionState, string> = {
  idle: "לא מחובר",
  connecting: "מתחבר…",
  ready: "מחוברת · מוכנה לצילום",
  busy: "מצלמת…",
  disconnected: "מנותק",
  error: "שגיאה",
};

const KIND_LABEL = { WEBCAM: "מצלמת רשת", SIMULATOR: "סימולטור", CANON: "Canon EDSDK", DIGICAM: "digiCamControl", AGENT_SIMULATOR: "סימולטור Agent" } as const;

const PROCESSED_STATE: Record<string, string> = {
  QUEUED: "בתור לעיבוד",
  PREVIEW_READY: "תצוגה מהירה — הגרסה המלאה בדרך",
  DONE: "מעובדת",
  NEEDS_REVIEW: "דורשת בדיקה — לא נחתכה אוטומטית",
  FAILED: "העיבוד נכשל — המקור שמור",
};

function processedLabel(p: NonNullable<AssetDto["processed"]>): string {
  return `${PROCESSED_STATE[p.state] ?? p.state}${p.confidence !== null ? ` · ביטחון ${Math.round(p.confidence * 100)}%` : ""}`;
}
export function CaptureStudio({
  user,
  initialContext,
  initialCategory,
  serverPrefs,
  simulatorAllowed,
}: {
  user: { id: string; name: string; canOrganize: boolean; canStatus: boolean; canDelete: boolean; canCreate: boolean };
  initialContext: CaptureLotContext;
  initialCategory: PhotoCategory;
  serverPrefs: unknown;
  simulatorAllowed: boolean;
}) {
  const toast = useToast();
  const root = useRef<HTMLDivElement>(null);

  // ── work context ───────────────────────────────────────────────
  const [ctx, setCtx] = useState(initialContext);
  const [category, setCategoryState] = useState<PhotoCategory>(initialCategory);
  const ctxRef = useRef(ctx);
  const categoryRef = useRef(category);
  ctxRef.current = ctx;
  categoryRef.current = category;

  const [prefs, setPrefsState] = useState<CapturePrefs>(DEFAULT_PREFS);
  useEffect(() => setPrefsState(mergePrefs(serverPrefs)), [serverPrefs]);
  const setPrefs = useCallback((patch: Partial<CapturePrefs>) => {
    setPrefsState((p) => {
      const next = { ...p, ...patch };
      void savePrefs(next).catch(() => undefined);
      return next;
    });
  }, []);

  // ── camera profile: processing settings + camera values, persisted and restored ──
  const profile = useCaptureProfile(prefs.activeProfileId, (id) => setPrefs({ activeProfileId: id }));
  const processing = profile.settings.processing;
  const processingRef = useRef(processing);
  processingRef.current = processing;
  const patchRef = useRef(profile.patchProcessing);
  patchRef.current = profile.patchProcessing;

  // ── camera ─────────────────────────────────────────────────────
  const driverRef = useRef<CameraDriver | null>(null);
  const [choice, setChoice] = useState<CameraChoice | null>(null);
  const [conn, setConn] = useState<{ state: ConnectionState; message?: string }>({ state: "idle" });
  const [info, setInfo] = useState<CameraInfo | null>(null);
  const [controls, setControls] = useState<CameraControl[]>([]);
  const [preview, setPreview] = useState<HTMLVideoElement | HTMLCanvasElement | HTMLImageElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = sessionId;

  // ── shots ──────────────────────────────────────────────────────
  const [shots, setShots] = useState<Map<string, LocalShot>>(new Map());

  const inflight = useRef(false);
  const shotsRef = useRef<Map<string, LocalShot>>(new Map());
  shotsRef.current = shots;
  const lastTrigger = useRef(0);
  const [flashKey, setFlashKey] = useState(0);
  const [replaceTarget, setReplaceTarget] = useState<string | null>(null);
  const replaceRef = useRef<string | null>(null);
  replaceRef.current = replaceTarget;
  const pendingReplace = useRef(new Map<string, string>()); // new captureId → old assetId

  // ── view ───────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(1);
  // 1 source pixel = 1 screen pixel, and the sharpness diagnostics (measured from the live element)
  const [oneToOne, setOneToOne] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [metrics, setMetrics] = useState<LiveMetrics | null>(null);
  const evfCtl = controls.find((c) => c.id === "evfZoom");
  // rotation belongs to the profile: it turns the live view and the saved (processed) pixels alike
  const rotation = processing.rotation;
  const [peaking, setPeaking] = useState(false);
  // hardware focus magnification (digiCamControl / Canon): a sensor region shown at true pixel density for a sharp focus check
  const [focusZoom, setFocusZoom] = useState(false);
  const [hidePanels, setHidePanels] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [health, setHealth] = useState<StorageHealth>({ freeBytes: null, level: "ok" });
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [newBook, setNewBook] = useState<null | "new" | "finish">(null);
  const [completing, setCompleting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [liveStatus, setLiveStatus] = useState<LiveSegStatus | null>(null);
  const [editAsset, setEditAsset] = useState<AssetDto | null>(null);
  const rotateView = useCallback(() => patchRef.current({ rotation: ((processingRef.current.rotation + 90) % 360) as 0 | 90 | 180 | 270 }), []);

  // toggle the camera's own focus-magnification (sharp focus check despite the low-resolution live-view stream)
  const toggleFocusZoom = useCallback(() => {
    setFocusZoom((on) => {
      const next = !on;
      if (next) setZoom(1);
      // 50% = a moderate magnification: a sharp region without cropping in too close (100% is 1:1 and far too tight)
      void driverRef.current?.setControl?.(`focus:LiveView_Zoom_${next ? "50" : "All"}`, true).catch(() => {
        setFocusZoom(false);
        toast.warning("הגדלת פוקוס חומרתית אינה נתמכת במצלמה זו");
      });
      return next;
    });
  }, [toast]);

  const updateShot = useCallback((captureId: string, patch: Partial<LocalShot> & { lotId?: string; category?: PhotoCategory }) => {
    setShots((m) => {
      const prev = m.get(captureId);
      if (!prev && !patch.lotId) return m;
      const next = new Map(m);
      next.set(captureId, { ...(prev ?? { captureId, lotId: patch.lotId!, category: patch.category!, stage: "CAPTURING", createdAt: Date.now() }), ...patch } as LocalShot);
      return next;
    });
  }, []);

  // server asset refresh (debounced)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshAssets = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(async () => {
      const lotId = ctxRef.current.lot.id;
      try {
        const r = await api<{ assets: AssetDto[] }>(`/api/lots/${lotId}/assets`);
        if (ctxRef.current.lot.id === lotId) setCtx((c) => ({ ...c, assets: r.assets }));
      } catch {
        /* next event will retry */
      }
    }, 700);
  }, []);

  // pending outbox entries for this lot (e.g. after a crash or reload) appear in the strip
  useEffect(() => {
    let alive = true;
    outbox
      .all(user.id)
      .then((entries) => {
        if (!alive) return;
        setShots((m) => {
          const next = new Map(m);
          for (const e of entries) {
            if (next.has(e.captureId)) continue;
            const primary = e.files.find((f) => f.role === "PRIMARY");
            next.set(e.captureId, {
              captureId: e.captureId,
              lotId: e.lotId,
              category: e.category,
              stage: e.stage === "UPLOADING" ? "QUEUED" : e.stage,
              localUrl: primary ? URL.createObjectURL(primary.blob) : undefined,
              createdAt: e.createdAt,
              error: e.lastError,
            });
          }
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [user.id]);

  // browser uploader events
  useEffect(
    () =>
      uploader.subscribe((e) => {
        updateShot(e.captureId, { stage: e.stage, error: e.error ?? null, assetId: e.assetId, sequence: e.sequence });
        if (e.stage === "VERIFIED") {
          refreshAssets();
          const old = pendingReplace.current.get(e.captureId);
          if (old) offerReplaceDelete(e.captureId, old);
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [updateShot, refreshAssets],
  );

  // storage headroom (browser drivers)
  useEffect(() => {
    const check = () => storageHealth().then(setHealth);
    void check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, []);

  // ── camera connection ──────────────────────────────────────────
  const connectChoice = useCallback(
    async (c: CameraChoice) => {
      setPickerOpen(false);
      const old = driverRef.current;
      driverRef.current = null;
      if (old) await old.disconnect().catch(() => undefined);
      setPreview(null);
      setInfo(null);
      setControls([]);
      setFocusZoom(false);
      setChoice(c);

      let driver: CameraDriver;
      if (c.kind === "WEBCAM") driver = new WebcamDriver(c.id, c.label);
      else if (c.kind === "SIMULATOR") driver = new SimulatorDriver();
      else
        driver = new AgentDriver(c.agentUrl, c.id, c.label, c.cameraKind, async () => {
          const r = await api<{ token: string }>(`/api/devices/${c.id}/control-token`, { method: "POST" });
          return r.token;
        });
      driverRef.current = driver;
      driver.on("state", (s, message) => {
        if (driverRef.current !== driver) return;
        setConn({ state: s, message });
        if (s === "ready") setPreview(driver.previewElement());
      });
      driver.on("info", (i) => driverRef.current === driver && setInfo(i));
      driver.on("controls", (cs) => driverRef.current === driver && setControls(cs));
      driver.on("agent-capture", (u) => {
        if (driverRef.current !== driver) return;
        const current = ctxRef.current;
        updateShot(u.captureId, {
          stage: u.stage,
          thumbUrl: u.thumbUrl,
          error: u.error,
          assetId: u.assetId ?? undefined,
          ...(u.external && u.lotId && u.category ? { lotId: u.lotId, category: u.category } : {}),
        });
        if (u.stage === "SAVED_LOCAL" && u.external && u.lotId === current.lot.id) {
          setFlashKey((k) => k + 1);
          if (prefsRef.current.sound) playShutter();
        }
        if (u.stage === "VERIFIED") {
          refreshAssets();
          const old = pendingReplace.current.get(u.captureId);
          if (old) offerReplaceDelete(u.captureId, old);
        }
        if (u.stage === "FAILED") toast.error("הצילום נכשל", { detail: u.error ?? undefined });
      });
      try {
        await driver.connect();
        setPreview(driver.previewElement());
        setInfo(driver.info());
        setControls(driver.controls());
        // the camera may still be in focus-magnification from a previous session — start from the full view.
        // live view starts a moment after connect, so re-send once it is up to reliably clear a stuck zoom box.
        if (c.kind === "DIGICAM") {
          const resetZoom = () => driverRef.current === driver && void driver.setControl?.("focus:LiveView_Zoom_All", true).catch(() => undefined);
          resetZoom();
          setTimeout(resetZoom, 1200);
        }
        setPrefs({ lastCamera: { kind: c.kind, id: c.id, label: c.label } });
        const cur = ctxRef.current;
        await driver.setActiveContext?.({
          lotId: cur.lot.id,
          catalogId: cur.catalog.id,
          category: categoryRef.current,
          lotNumber: cur.lot.lotNumber,
          catalogNumber: cur.catalog.number,
          processing: processingRef.current,
        });
        const s = await api<{ session: { id: string } }>("/api/capture-sessions", {
          method: "POST",
          json: {
            lotId: cur.lot.id,
            category: categoryRef.current,
            cameraKind: c.kind,
            cameraName: driver.info().name,
            deviceId: c.kind === "CANON" || c.kind === "DIGICAM" || c.kind === "AGENT_SIMULATOR" ? c.id : null,
          },
        }).catch(() => null);
        setSessionId(s?.session.id ?? null);
      } catch {
        /* state event already carries the message */
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshAssets, setPrefs, toast, updateShot],
  );

  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  // first camera: the last one used, else ask
  const autoConnected = useRef(false);
  useEffect(() => {
    if (autoConnected.current) return;
    const p = mergePrefs(serverPrefs);
    autoConnected.current = true;
    const last = p.lastCamera;
    if (last?.kind === "WEBCAM") void connectChoice({ kind: "WEBCAM", id: last.id, label: last.label ?? "מצלמת רשת" });
    else if (last?.kind === "SIMULATOR" && simulatorAllowed) void connectChoice({ kind: "SIMULATOR", id: "simulator", label: "סימולטור" });
    else if (last && (last.kind === "CANON" || last.kind === "DIGICAM" || last.kind === "AGENT_SIMULATOR")) {
      // the station is reconnected without asking again; we connect even when the camera is currently off —
      // the agent keeps the session and live view starts on its own once the camera is turned on. The picker
      // opens only when the agent itself is not running on this machine.
      void probeAgent(p.agentUrl).then((hello) => {
        if (hello?.paired && hello.deviceId === last.id) {
          void connectChoice({
            kind: hello.camera.kind === "SIMULATOR" ? "AGENT_SIMULATOR" : hello.camera.kind === "DIGICAM" ? "DIGICAM" : "CANON",
            id: last.id,
            label: last.label ?? hello.deviceName ?? "עמדת צילום",
            agentUrl: p.agentUrl,
            cameraKind: hello.camera.kind,
          });
        } else setPickerOpen(true);
      });
    } else setPickerOpen(true);
  }, [connectChoice, serverPrefs, simulatorAllowed]);

  // webcam came back after unplug → reconnect automatically
  useEffect(() => {
    if (conn.state !== "disconnected" || choice?.kind !== "WEBCAM") return;
    const onChange = async () => {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (devices.some((d) => d.kind === "videoinput" && d.deviceId === choice.id)) void connectChoice(choice);
    };
    navigator.mediaDevices?.addEventListener("devicechange", onChange);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", onChange);
  }, [conn.state, choice, connectChoice]);

  useEffect(
    () => () => {
      void driverRef.current?.disconnect();
      if (sessionRef.current) void api(`/api/capture-sessions/${sessionRef.current}`, { method: "PATCH", json: { end: true } }).catch(() => undefined);
    },
    [],
  );

  // ── context changes (never disconnect the camera) ──────────────
  const persistPosition = useCallback((lotId: string, cat: PhotoCategory) => {
    void api("/api/preferences/workPosition", { method: "PUT", json: { value: { lotId, category: cat, at: new Date().toISOString() } } }).catch(() => undefined);
    if (sessionRef.current) void api(`/api/capture-sessions/${sessionRef.current}`, { method: "PATCH", json: { activeCategory: cat, lotId } }).catch(() => undefined);
    const c = ctxRef.current;
    void driverRef.current
      ?.setActiveContext?.({ lotId, catalogId: c.catalog.id, category: cat, lotNumber: c.lot.lotNumber, catalogNumber: c.catalog.number, processing: processingRef.current })
      .catch(() => undefined);
  }, []);

  const setCategory = useCallback(
    (cat: PhotoCategory) => {
      categoryRef.current = cat;
      setCategoryState(cat);
      setReplaceTarget(null);
      const url = new URL(window.location.href);
      url.searchParams.set("category", cat);
      window.history.replaceState(null, "", url.toString());
      persistPosition(ctxRef.current.lot.id, cat);
    },
    [persistPosition],
  );

  useEffect(() => persistPosition(initialContext.lot.id, initialCategory), [initialContext.lot.id, initialCategory, persistPosition]);

  const switchLot = useCallback(
    async (lotId: string, cat: PhotoCategory = "COVER") => {
      try {
        const next = await api<CaptureLotContext>(`/api/lots/${lotId}/capture-context`);
        ctxRef.current = next;
        categoryRef.current = cat;
        setCtx(next);
        setCategoryState(cat);
        setReplaceTarget(null);
        window.history.replaceState(null, "", `/capture/${lotId}?category=${cat}`);
        persistPosition(lotId, cat);
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
    [persistPosition, toast],
  );

  // ── the capture pipeline ───────────────────────────────────────
  const trigger = useCallback(async () => {
    const driver = driverRef.current;
    const now = Date.now();
    if (!driver || inflight.current || now - lastTrigger.current < 300) return;
    if (conn.state !== "ready") {
      toast.warning(conn.state === "disconnected" ? "המצלמה מנותקת — לא בוצע צילום" : "המצלמה אינה מוכנה לצילום");
      return;
    }
    if (driver.storage === "browser") {
      const h = await storageHealth();
      setHealth(h);
      if (h.level === "critical") {
        toast.error("אין מספיק מקום באחסון המקומי של הדפדפן", { detail: "הצילום נחסם כדי לא לאבד תמונות. המתינו לסיום ההעלאות או פנו מקום בדיסק." });
        return;
      }
    }
    lastTrigger.current = now;
    inflight.current = true;

    // freeze the association NOW — later category/lot switches cannot affect this shot
    const c = ctxRef.current;
    const frozen: CaptureContext = {
      captureId: crypto.randomUUID(),
      lotId: c.lot.id,
      catalogId: c.catalog.id,
      category: categoryRef.current,
      lotNumber: c.lot.lotNumber,
      catalogNumber: c.catalog.number,
      sessionId: sessionRef.current ?? undefined,
      processing: processingRef.current,
    };
    if (replaceRef.current) {
      pendingReplace.current.set(frozen.captureId, replaceRef.current);
      setReplaceTarget(null);
    }
    updateShot(frozen.captureId, { lotId: frozen.lotId, category: frozen.category, stage: "CAPTURING", createdAt: now });
    setFlashKey((k) => k + 1);
    if (prefsRef.current.sound) playShutter();

    try {
      const shot = await driver.capture(frozen);
      if (shot.kind === "agent") return; // agent reports SAVED_LOCAL etc. via events
      const files = await Promise.all(
        shot.files.map(async (f) => ({ ...f, sizeBytes: f.blob.size, sha256: await sha256Hex(f.blob) })),
      );
      const entry: OutboxEntry = {
        captureId: frozen.captureId,
        userId: user.id,
        lotId: frozen.lotId,
        catalogId: frozen.catalogId,
        category: frozen.category,
        lotLabel: `${frozen.catalogNumber}/${frozen.lotNumber}`,
        source: driver.kind === "SIMULATOR" ? "SIMULATOR" : "WEBCAM",
        cameraName: driver.info().name,
        sessionId: frozen.sessionId,
        capturedAt: new Date(now).toISOString(),
        exif: shot.exif,
        processing: frozen.processing,
        files,
        stage: "SAVED_LOCAL",
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: now,
      };
      await outbox.put(entry); // resolves only after the IndexedDB commit
      const primary = files.find((f) => f.role === "PRIMARY");
      updateShot(frozen.captureId, { stage: "SAVED_LOCAL", localUrl: primary ? URL.createObjectURL(primary.blob) : undefined });
      uploader.kick();
    } catch (err) {
      pendingReplace.current.delete(frozen.captureId);
      updateShot(frozen.captureId, { stage: "FAILED", error: errorMessage(err) });
      toast.error("הצילום נכשל — התמונה לא נשמרה", { detail: errorMessage(err), action: { label: "צילום שוב", onClick: () => void trigger() } });
    } finally {
      inflight.current = false;
    }
  }, [conn.state, toast, updateShot, user.id]);

  // ── keyboard ───────────────────────────────────────────────────
  const handledSpace = useRef(false);
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || document.querySelector("dialog[open]") || viewerIndex !== null) return;
      const p = prefsRef.current;
      if (e.code === "Space" || (p.captureKey && e.code === p.captureKey)) {
        e.preventDefault();
        handledSpace.current = true;
        if (!e.repeat) void trigger();
        (document.activeElement as HTMLElement | null)?.blur?.();
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const ci = p.categoryKeys.indexOf(e.code);
      if (ci >= 0) {
        e.preventDefault();
        setCategory(PHOTO_CATEGORIES[ci]!);
      } else if (e.code === p.nextLotKey && ctxRef.current.next) {
        e.preventDefault();
        void switchLot(ctxRef.current.next.id);
      } else if (e.code === p.prevLotKey && ctxRef.current.prev) {
        e.preventDefault();
        void switchLot(ctxRef.current.prev.id);
      } else if (e.code === "KeyG") setPrefs({ grid: p.grid === "none" ? "thirds" : p.grid === "thirds" ? "fine" : "none" });
      else if (e.code === "KeyH") setHidePanels((h) => !h);
      else if (e.code === "KeyF") void root.current?.requestFullscreen?.();
      else if (e.code === "KeyZ") setZoom((z) => (z >= 4 ? 1 : z * 2));
      else if (e.code === "KeyR") rotateView();
    };
    const onUp = (e: KeyboardEvent) => {
      if (handledSpace.current && (e.code === "Space" || e.code === prefsRef.current.captureKey)) {
        e.preventDefault();
        handledSpace.current = false;
      }
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
    };
  }, [trigger, setCategory, switchLot, setPrefs, viewerIndex, rotateView]);

  // ── filmstrip model ────────────────────────────────────────────
  const allItems = useMemo<StripItem[]>(() => {
    const byCapture = new Map<string, StripItem>();
    for (const a of ctx.assets) {
      byCapture.set(a.captureId, {
        key: a.captureId,
        captureId: a.captureId,
        assetId: a.id,
        category: a.category,
        seq: a.sequence,
        stage: SERVER_STAGE[a.uploadStatus],
        src: a.thumbUrl,
        rotation: a.rotation,
        isPrimary: a.isPrimary,
        processing: a.processed && a.processed.state !== "NONE" ? { state: a.processed.state, warnings: a.processed.warnings.map(warningLabel) } : null,
        createdAt: new Date(a.capturedAt).getTime(),
      });
    }
    for (const s of shots.values()) {
      if (s.lotId !== ctx.lot.id) continue;
      const server = byCapture.get(s.captureId);
      if (server) {
        // the server is the source of truth once it holds the asset
        if (server.stage !== "VERIFIED") server.stage = s.stage === "VERIFIED" ? "VERIFIED" : s.stage;
        server.src ??= s.localUrl ?? s.thumbUrl ?? null;
        continue;
      }
      if (s.stage === "VERIFIED" && s.assetId) continue; // verified but deleted meanwhile
      byCapture.set(s.captureId, {
        key: s.captureId,
        captureId: s.captureId,
        assetId: s.assetId,
        category: s.category,
        seq: s.sequence,
        stage: s.stage,
        src: s.localUrl ?? s.thumbUrl ?? null,
        rotation: 0,
        isPrimary: false,
        error: s.error,
        createdAt: s.createdAt,
      });
    }
    return [...byCapture.values()].sort((a, b) => a.createdAt - b.createdAt);
  }, [ctx.assets, ctx.lot.id, shots]);

  const counts = useMemo(() => {
    const m = Object.fromEntries(PHOTO_CATEGORIES.map((c) => [c, 0])) as Record<PhotoCategory, number>;
    for (const it of allItems) if (it.stage !== "FAILED") m[it.category]++;
    return m;
  }, [allItems]);

  const stripItems = prefs.filmstripScope === "all" ? allItems : allItems.filter((i) => i.category === category);
  const pendingHere = allItems.filter((i) => i.stage !== "VERIFIED" && i.stage !== "FAILED").length;
  const processingCount = ctx.assets.filter((a) => a.processed?.state === "QUEUED" || a.processed?.state === "PREVIEW_READY").length;

  // the full-resolution pass finishes in the background — pick up the final image without a reload
  useEffect(() => {
    if (processingCount === 0) return;
    const id = setInterval(refreshAssets, 2500);
    return () => clearInterval(id);
  }, [processingCount, refreshAssets]);

  // the active profile's camera values are restored once per connection (only what this camera reports)
  const restoredFor = useRef<CameraDriver | null>(null);
  useEffect(() => {
    const d = driverRef.current;
    if (!d || conn.state !== "ready" || !profile.ready || restoredFor.current === d) return;
    restoredFor.current = d;
    if (d.kind === "AGENT_SIMULATOR" || d.kind === "SIMULATOR") return;
    for (const c of d.controls()) {
      const v = profile.settings.camera[c.id];
      if (v === undefined || c.readOnly || c.type === "action") continue;
      if (c.type === "select" && !c.options?.some((o) => o.value === String(v))) continue;
      if (String(c.value) === String(v)) continue;
      d.setControl(c.id, v).catch(() => undefined);
    }
  }, [conn.state, controls, profile.ready, profile.settings.camera]);

  const saveCameraValues = () => {
    const values: Record<string, string | number | boolean> = {};
    for (const c of controls) if (c.type !== "action" && !c.readOnly && c.value !== undefined && c.value !== null) values[c.id] = c.value;
    profile.setCameraValues(values);
    toast.success("הגדרות המצלמה נשמרו בפרופיל");
  };

  // hardware-shutter shots use the profile that is active now
  useEffect(() => {
    const c = ctxRef.current;
    void driverRef.current
      ?.setActiveContext?.({ lotId: c.lot.id, catalogId: c.catalog.id, category: categoryRef.current, lotNumber: c.lot.lotNumber, catalogNumber: c.catalog.number, processing })
      .catch(() => undefined);
  }, [processing]);

  // ── filmstrip actions ──────────────────────────────────────────
  async function deleteAsset(it: StripItem) {
    if (!it.assetId) return;
    try {
      await api("/api/assets/delete", { method: "POST", json: { assetIds: [it.assetId] } });
      refreshAssets();
      toast.success(`צילום ${it.seq ?? ""} הועבר לסל המחזור`, {
        action: {
          label: "ביטול",
          onClick: () => void api("/api/assets/restore", { method: "POST", json: { assetIds: [it.assetId] } }).then(refreshAssets),
        },
      });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  function offerReplaceDelete(newCaptureId: string, oldAssetId: string) {
    pendingReplace.current.delete(newCaptureId);
    const old = ctxRef.current.assets.find((a) => a.id === oldAssetId);
    toast.info("הצילום החלופי נשמר ואומת", {
      detail: `הצילום הקודם${old ? ` (#${old.sequence})` : ""} עדיין קיים.`,
      action: {
        label: "העברת הקודם לסל",
        onClick: async () => {
          try {
            const r = await api<{ assets: AssetDto[] }>(`/api/lots/${ctxRef.current.lot.id}/assets?category=${old?.category ?? categoryRef.current}`);
            const ordered = r.assets.map((a) => a.id);
            const fresh = r.assets.find((a) => a.captureId === newCaptureId);
            await api("/api/assets/delete", { method: "POST", json: { assetIds: [oldAssetId] } });
            // the replacement takes the old photo's place in the order
            if (fresh && old) {
              const without = ordered.filter((id) => id !== oldAssetId && id !== fresh.id);
              const at = Math.max(0, ordered.indexOf(oldAssetId));
              without.splice(Math.min(at, without.length), 0, fresh.id);
              await api("/api/assets/reorder", { method: "POST", json: { lotId: ctxRef.current.lot.id, category: old.category, orderedIds: without } });
            }
            refreshAssets();
            toast.success("הצילום הקודם הועבר לסל המחזור");
          } catch (err) {
            toast.error(errorMessage(err));
          }
        },
      },
    });
  }

  async function setPrimary(it: StripItem) {
    if (!it.assetId) return;
    try {
      await api(`/api/assets/${it.assetId}/primary`, { method: "POST" });
      refreshAssets();
      toast.success("התמונה הוגדרה כתמונה ראשית של הספר");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  // ── new book without leaving the studio ────────────────────────
  /**
   * True once the last shot is safely stored (IndexedDB commit / agent disk + queue). The upload to the cloud
   * is NOT awaited. Gives up after 30 s so a stuck driver can never trap the worker.
   */
  const waitDurable = useCallback(async () => {
    const until = Date.now() + 30_000;
    for (;;) {
      const capturing = [...shotsRef.current.values()].some((s) => s.stage === "CAPTURING");
      if (!inflight.current && !capturing) return true;
      if (Date.now() > until) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }, []);

  async function markComplete() {
    // the photo status belongs to the book; a catalog lot mirrors it
    if (ctxRef.current.target === "item") await api(`/api/inventory/${ctxRef.current.item.id}`, { method: "PATCH", json: { photoStatus: prefs.completeStatus } });
    else await api(`/api/lots/${ctxRef.current.lot.id}`, { method: "PATCH", json: { status: prefs.completeStatus } });
    setCtx((c) => ({ ...c, lot: { ...c.lot, status: prefs.completeStatus } }));
  }

  // ── lot completion / continuous mode ───────────────────────────
  async function completeLot() {
    setCompleting(true);
    try {
      await markComplete();
      toast.success(`${ctx.target === "item" ? ctx.item.inventoryNumber : `פריט ${ctx.lot.lotNumber}`} סומן: ${t.lotStatus[prefs.completeStatus]}`);
      setAdvanceOpen(false);
      if (ctx.next && prefs.continuous) await switchLot(ctx.next.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCompleting(false);
    }
  }

  // ── viewer ─────────────────────────────────────────────────────
  const viewerItems: ViewerItem[] = stripItems.map((it) => {
    const asset = it.assetId ? ctx.assets.find((a) => a.id === it.assetId) : undefined;
    const d = asset ? assetViewerDetails(asset) : null;
    // sharp source that matches the preview: the full-res processed file, else the processed preview until it is ready, else the raw original
    const full = asset ? (asset.processedUrl ?? (asset.processed ? asset.previewUrl : `/api/assets/${asset.id}/original`)) : it.src;
    return {
      key: it.key,
      title: `${ctx.target === "item" ? ctx.item.inventoryNumber : `פריט ${ctx.lot.lotNumber}`} · ${t.category[it.category]} · צילום ${it.seq ?? "—"}`,
      src: asset?.previewUrl ?? it.src,
      fullSrc: full,
      originalSrc: asset ? `/api/assets/${asset.id}/original` : it.src,
      download: asset ? downloadOptions(asset) : null,
      hasProcessed: !!asset?.processed,
      rotation: it.rotation,
      details: [...(d?.details ?? [{ label: "מצב", value: t.uploadStage[it.stage] }]), ...(asset?.processed ? [{ label: "עיבוד", value: processedLabel(asset.processed) }] : [])],
      warnings: [...(d?.warnings ?? []), ...(asset?.processed?.warnings.map(warningLabel) ?? [])],
    };
  });

  const ready = conn.state === "ready";
  const isAgent = choice?.kind === "CANON" || choice?.kind === "DIGICAM" || choice?.kind === "AGENT_SIMULATOR";
  const agentQueue = isAgent ? (driverRef.current as AgentDriver | null)?.queueStatus?.() : null;
  const diskCritical = isAgent ? agentQueue?.disk.level === "critical" : health.level === "critical";
  // the live estimate does not trust the detection → the shot will be flagged "needs review" instead of auto-cropped
  const lowConfidence = ready && processing.liveMode !== "full" && !!liveStatus && liveStatus.confidence !== null && liveStatus.confidence < processing.minConfidence;

  return (
    <div ref={root} className="flex h-dvh flex-col overflow-hidden bg-studio text-studio-text">
      {/* top bar */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-studio-rule px-3">
        <Link
          href={ctx.target === "item" ? `/inventory/${ctx.item.id}` : `/lots/${ctx.lot.id}`}
          className="flex h-9 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-studio-muted transition-colors hover:bg-studio-3 hover:text-studio-text"
          title="חזרה למסך הספר"
        >
          <ArrowRight className="size-4" />
          <span className="hidden sm:inline">למסך הספר</span>
        </Link>
        <span className="h-6 w-px bg-studio-rule" aria-hidden />
        <div className="min-w-0 truncate text-[13.5px]">
          {ctx.target === "lot" ? (
            <>
              <span className="text-studio-muted">קטלוג {ctx.catalog.number} · </span>
              <span className="font-semibold">
                פריט <span className="num">{ctx.lot.lotNumber}</span> · {ctx.lot.title}
              </span>
              <span className="num ms-2 font-mono text-[12px] text-studio-muted">{ctx.item.inventoryNumber}</span>
            </>
          ) : (
            <>
              <span className="text-studio-muted">מלאי · </span>
              <span className="font-semibold">
                <span className="num font-mono">{ctx.item.inventoryNumber}</span> · {ctx.lot.title}
              </span>
            </>
          )}
        </div>
        <div className="ms-auto flex items-center gap-2">
          {user.canCreate && (
            <button
              type="button"
              onClick={() => setNewBook("new")}
              className="flex h-9 items-center gap-1.5 rounded-md bg-studio-text px-3 text-[13px] font-semibold text-studio transition-colors hover:bg-white"
              title="יצירת ספר חדש ומעבר מיידי לצילומו"
            >
              <BookPlus className="size-4" />
              ספר חדש
            </button>
          )}
          <StudioIcon onClick={() => setScanOpen(true)} title="פתיחת ספר בסריקת ברקוד">
            <ScanLine />
          </StudioIcon>
          <StudioIcon onClick={() => setSettingsOpen(true)} title="הגדרות מצלמה ועיבוד">
            <SlidersHorizontal />
          </StudioIcon>
          <button
            onClick={() => setPickerOpen(true)}
            className="flex h-9 items-center gap-2 rounded-full bg-studio-2 px-3 text-[12.5px] ring-1 ring-studio-rule transition-colors hover:bg-studio-3"
            title="החלפת מצלמה"
          >
            <span
              className={cn(
                "size-2 rounded-full",
                conn.state === "ready" ? "bg-[#3ecf8e] shadow-[0_0_0_3px_rgb(62_207_142/0.18)]" : conn.state === "connecting" || conn.state === "busy" ? "bg-[#e8b04b]" : "bg-[#ef5b4c]",
              )}
              aria-hidden
            />
            <span className="max-w-48 truncate font-medium">{info?.name ?? choice?.label ?? "בחירת מצלמה"}</span>
            <span className="hidden text-studio-muted md:inline">{conn.state === "ready" && processingCount > 0 ? "מחוברת · מעבדת תמונות" : STATE_LABEL[conn.state]}</span>
            {info?.resolution && (
              <span className="num hidden text-studio-muted lg:inline">
                {info.resolution.width}×{info.resolution.height}
              </span>
            )}
          </button>
          {isAgent && agentQueue ? (
            <span className="flex h-8 items-center rounded-full bg-studio-3 px-3 text-[12.5px]" title="תור ההעלאה של Capture Agent">
              Agent: <span className="num ms-1">{agentQueue.pending}</span>&nbsp;ממתינות
              {agentQueue.failed > 0 && <span className="text-[#f6c3bb]"> · {agentQueue.failed} נכשלו</span>}
            </span>
          ) : (
            <OutboxIndicator userId={user.id} tone="studio" />
          )}
          <StudioIcon onClick={() => setHidePanels((h) => !h)} title="הסתרת/הצגת פאנל (H)">
            {hidePanels ? <PanelRightOpen /> : <PanelRightClose />}
          </StudioIcon>
          <StudioIcon onClick={() => root.current?.requestFullscreen?.()} title="מסך מלא (F)">
            <Maximize />
          </StudioIcon>
        </div>
      </header>

      {info?.notice && <div className="shrink-0 bg-[#4a1d1a] px-3 py-1.5 text-center text-[12.5px] text-[#f6c3bb]">{info.notice}</div>}

      <div className="flex min-h-0 flex-1">
        {/* side panel */}
        {!hidePanels && (
          <aside className="flex w-[304px] shrink-0 flex-col overflow-y-auto border-e border-studio-rule bg-studio-2">
            <section className="px-4 pb-4 pt-4">
              <div className="flex items-center justify-between text-[12px] text-studio-muted">
                <span>{ctx.target === "lot" ? `קטלוג ${ctx.catalog.number} · ${ctx.item.inventoryNumber}` : "מלאי"}</span>
                <span className="rounded-full bg-studio-3 px-2 py-0.5">{t.lotStatus[ctx.lot.status]}</span>
              </div>
              <div className="mt-2 flex items-baseline gap-2.5">
                <span className={cn("num font-semibold leading-none tracking-[-0.02em]", ctx.target === "item" ? "font-mono text-[22px]" : "text-[34px]")}>
                  {ctx.target === "item" ? ctx.item.inventoryNumber : ctx.lot.lotNumber}
                </span>
                <span className="min-w-0 truncate text-[15px] font-semibold">{ctx.lot.title}</span>
              </div>
              {(ctx.lot.subtitle || ctx.lot.author) && <div className="mt-1.5 truncate text-[12.5px] text-studio-muted">{[ctx.lot.author, ctx.lot.subtitle].filter(Boolean).join(" · ")}</div>}
              <div className="mt-4 flex items-center gap-1.5">
                <Button size="sm" variant="studio" disabled={!ctx.prev} onClick={() => ctx.prev && switchLot(ctx.prev.id)} title={`פריט קודם (${keyLabel(prefs.prevLotKey)})`} className="px-2">
                  <ChevronRight />
                  {ctx.prev ? <span className="num">{ctx.prev.lotNumber}</span> : "—"}
                </Button>
                <Button size="sm" variant="studio" disabled={!ctx.next} onClick={() => ctx.next && switchLot(ctx.next.id)} title={`פריט הבא (${keyLabel(prefs.nextLotKey)})`} className="px-2">
                  {ctx.next ? <span className="num">{ctx.next.lotNumber}</span> : "—"}
                  <ChevronLeft />
                </Button>
                {user.canStatus && (
                  <Button size="sm" className="ms-auto bg-studio-text text-studio hover:bg-white" icon={<Check />} onClick={() => setAdvanceOpen(true)}>
                    סיום פריט
                  </Button>
                )}
              </div>
            </section>

            <section className="border-t border-studio-rule px-3 py-3" aria-label="קטגוריה פעילה">
              <SectionTitle>קטגוריה</SectionTitle>
              <div className="grid gap-1" role="radiogroup">
                {PHOTO_CATEGORIES.map((c, i) => (
                  <button
                    key={c}
                    role="radio"
                    aria-checked={category === c}
                    onClick={() => setCategory(c)}
                    className={cn(
                      "flex h-11 items-center gap-2.5 rounded-lg px-3 text-start text-[14px] transition-colors",
                      category === c ? "bg-studio-text font-semibold text-studio" : "text-studio-text hover:bg-studio-3",
                    )}
                  >
                    <Kbd className={cn("border-transparent shadow-none", category === c ? "bg-studio/10 text-studio" : "bg-studio-3 text-studio-muted")}>{keyLabel(prefs.categoryKeys[i]!)}</Kbd>
                    <span className="flex-1">{t.category[c]}</span>
                    <span className={cn("num min-w-6 rounded-full px-1.5 text-center text-[12.5px] leading-6", category === c ? "bg-studio/10" : counts[c] ? "bg-studio-3" : "text-studio-muted")}>
                      {counts[c]}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section className="border-t border-studio-rule px-4 py-3 text-[12.5px]">
              <div className="mb-2 flex items-center justify-between">
                <SectionTitle className="mb-0">מצלמה</SectionTitle>
                {info?.battery != null && (
                  <span className="flex items-center gap-1 text-studio-muted">
                    <Battery className="size-3.5" />
                    <span className="num">{info.battery}%</span>
                  </span>
                )}
              </div>
              {conn.message && conn.state !== "ready" && <p className="mb-2 rounded-md bg-[#4a1d1a] px-2.5 py-2 text-[#f6c3bb]">{conn.message}</p>}
              {info?.readouts?.map((r) => (
                <div key={r.label} className="flex justify-between gap-2 py-0.5">
                  <span className="text-studio-muted">{r.label}</span>
                  <span className="num">{r.value}</span>
                </div>
              ))}
              {info?.formats && info.formats.length > 0 && (
                <div className="flex justify-between gap-2 py-0.5">
                  <span className="text-studio-muted">פורמט</span>
                  <span>{info.formats.join(" + ")}</span>
                </div>
              )}
              {controls.length > 0 && (
                <div className="mt-2 space-y-3">
                  {controls.map((c) => (
                    <ControlRow key={c.id} control={c} onChange={(v) => driverRef.current?.setControl(c.id, v).catch((e) => toast.error(errorMessage(e)))} />
                  ))}
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {info?.canAutofocus && (
                  <Button size="sm" variant="studio" icon={<Focus />} onClick={() => driverRef.current?.autofocus?.().catch((e) => toast.error(errorMessage(e)))}>
                    פוקוס אוטומטי
                  </Button>
                )}
                {(conn.state === "disconnected" || conn.state === "error") && choice && (
                  <Button size="sm" variant="studio" icon={<RefreshCw />} onClick={() => connectChoice(choice)}>
                    חיבור מחדש
                  </Button>
                )}
                <Button size="sm" variant="studio" icon={<Camera />} onClick={() => setPickerOpen(true)}>
                  החלפת מצלמה
                </Button>
                <Button size="sm" variant="studio" icon={<SlidersHorizontal />} onClick={() => setSettingsOpen(true)}>
                  הגדרות מצלמה
                </Button>
              </div>
              {choice?.kind === "CANON" && <p className="mt-2 text-[11.5px] leading-snug text-studio-muted">זום עדשת הקיט וגובה המצלמה משתנים ידנית במצלמה ובעמוד הצילום.</p>}
            </section>

            <section className="mt-auto border-t border-studio-rule px-4 py-3">
              <SectionTitle>עבודה</SectionTitle>
              <div className="space-y-2.5">
                <Switch tone="studio" label="צליל אישור צילום" checked={prefs.sound} onChange={(e) => setPrefs({ sound: e.target.checked })} />
                <Switch tone="studio" label="צילום רציף לפי פריטים" checked={prefs.continuous} onChange={(e) => setPrefs({ continuous: e.target.checked })} />
                <Switch
                  tone="studio"
                  label="רצועה: כל הקטגוריות"
                  checked={prefs.filmstripScope === "all"}
                  onChange={(e) => setPrefs({ filmstripScope: e.target.checked ? "all" : "category" })}
                />
              </div>
              <div className="mt-3 flex items-center justify-between text-[12px] text-studio-muted">
                <span>
                  צילום: <Kbd className="border-transparent bg-studio-3 text-studio-text shadow-none">רווח</Kbd>
                  {prefs.captureKey && (
                    <>
                      {" "}
                      או <Kbd className="border-transparent bg-studio-3 text-studio-text shadow-none">{keyLabel(prefs.captureKey)}</Kbd>
                    </>
                  )}
                </span>
                <Link href="/settings" className="hover:text-studio-text hover:underline">
                  מקשים ודוושה
                </Link>
              </div>
              {!isAgent && health.level !== "ok" && (
                <p className={cn("mt-3 rounded-md px-2.5 py-2 text-[12.5px]", health.level === "critical" ? "bg-[#4a1d1a] text-[#f6c3bb]" : "bg-[#4a3a1a] text-[#f2d79e]")}>
                  נפח פנוי באחסון הדפדפן: {fmt.bytes(health.freeBytes)}
                  {health.level === "critical" ? " — הצילום נחסם עד לפינוי מקום." : " — מומלץ להמתין לסיום ההעלאות."}
                </p>
              )}
              {isAgent && agentQueue && agentQueue.disk.level !== "ok" && (
                <p className="mt-3 rounded-md bg-[#4a1d1a] px-2.5 py-2 text-[12.5px] text-[#f6c3bb]">נפח דיסק בעמדה: {fmt.bytes(agentQueue.disk.freeBytes)}</p>
              )}
            </section>
          </aside>
        )}

        {/* live view + capture */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <LiveView
              preview={ready || conn.state === "busy" ? preview : null}
              grid={prefs.grid}
              centerLines={prefs.centerLines}
              zoom={zoom}
              rotation={rotation}
              oneToOne={oneToOne}
              onMetrics={setMetrics}
              peaking={peaking}
              onPeakingUnavailable={() => {
                setPeaking(false);
                toast.warning("הדגשת פוקוס אינה זמינה במצלמה זו");
              }}
              flashKey={flashKey}
              layer={
                <LiveSegmentation
                  preview={ready || conn.state === "busy" ? preview : null}
                  settings={processing}
                  mode={calibrating ? "frame" : focusZoom ? "full" : processing.liveMode}
                  calibrating={calibrating}
                  onCalibrate={(sample: BgSample) => {
                    patchRef.current({ bgSample: sample });
                    setCalibrating(false);
                    toast.success("צבע הרקע כויל ונשמר בפרופיל");
                  }}
                  onStatus={setLiveStatus}
                />
              }
            >
              {!ready && conn.state !== "busy" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                  <div className="flex size-14 items-center justify-center rounded-2xl bg-studio-3">
                    <Camera className="size-6 text-studio-muted" />
                  </div>
                  <p className="text-[15px] font-medium">{conn.state === "connecting" ? "מתחבר למצלמה…" : STATE_LABEL[conn.state]}</p>
                  {conn.message && <p className="max-w-md text-[13px] text-studio-muted">{conn.message}</p>}
                  <div className="mt-1 flex gap-2">
                    {choice && conn.state !== "connecting" && (
                      <Button variant="studio" icon={<RefreshCw />} onClick={() => connectChoice(choice)}>
                        חיבור מחדש
                      </Button>
                    )}
                    <Button className="bg-studio-text text-studio hover:bg-white" onClick={() => setPickerOpen(true)}>
                      בחירת מצלמה
                    </Button>
                    <Button variant="studio" icon={<SlidersHorizontal />} onClick={() => setSettingsOpen(true)}>
                      הגדרות מצלמה
                    </Button>
                  </div>
                </div>
              )}
            </LiveView>

            {diagOpen && (
              <div className="absolute bottom-3 start-3">
                <LiveDiagnostics
                  metrics={metrics}
                  driverKind={info?.kind}
                  evfZoom={controls.find((c) => c.id === "evfZoom")?.value as string | undefined}
                  processing={liveStatus ? ({ processed: "מעובדת", frame: "מסגרת", full: "מלאה", unavailable: "לא זמינה" } as const)[liveStatus.effective] : undefined}
                  onClose={() => setDiagOpen(false)}
                />
              </div>
            )}

            {/* view tools — display only, never written into the file */}
            <div className="absolute inset-x-0 top-3 flex justify-center px-3" role="toolbar" aria-label="כלי תצוגה (לא נשמרים בקובץ)">
              <div className="flex items-center gap-0.5 rounded-xl bg-black/55 p-1 ring-1 ring-white/10 backdrop-blur-md">
                <ToolButton active={prefs.grid !== "none"} onClick={() => setPrefs({ grid: prefs.grid === "none" ? "thirds" : prefs.grid === "thirds" ? "fine" : "none" })} title="רשת עזר (G)">
                  <Grid3x3 />
                  <span>{prefs.grid === "fine" ? "צפופה" : prefs.grid === "thirds" ? "שלישים" : "רשת"}</span>
                </ToolButton>
                <ToolButton active={prefs.centerLines} onClick={() => setPrefs({ centerLines: !prefs.centerLines })} title="קווי יישור מרכזיים">
                  <Crosshair />
                </ToolButton>
                <ToolButton active={peaking} onClick={() => setPeaking((p) => !p)} title="הדגשת פוקוס (focus peaking)">
                  {peaking ? <Eye /> : <EyeOff />}
                  <span>פוקוס</span>
                </ToolButton>
                <ToolButton active={rotation !== 0} onClick={rotateView} title="סיבוב (R) — חל על התצוגה ועל הקבצים המעובדים, נשמר בפרופיל">
                  <RotateCw />
                  {rotation !== 0 && <span className="num">{rotation}°</span>}
                </ToolButton>
                <span className="mx-1 h-5 w-px bg-white/15" aria-hidden />
                {(["processed", "frame", "full"] as const).map((m) => (
                  <ToolButton
                    key={m}
                    active={processing.liveMode === m}
                    onClick={() => profile.patchProcessing({ liveMode: m })}
                    title={m === "processed" ? "תצוגה מעובדת: הרקע מוסתר והספר חתוך (הערכה בלבד)" : m === "frame" ? "מסגרת גבולות הספר על התצוגה המלאה" : "תצוגה מלאה של המצלמה"}
                  >
                    <span>{m === "processed" ? "מעובדת" : m === "frame" ? "מסגרת" : "מלאה"}</span>
                  </ToolButton>
                ))}
                <span className="mx-1 h-5 w-px bg-white/15" aria-hidden />
                {[1, 2, 4].map((z) => (
                  <ToolButton key={z} active={zoom === z && !oneToOne} onClick={() => { setOneToOne(false); setZoom(z); }} title="הגדלה לבדיקת פוקוס (Z)">
                    <span className="num">{z}×</span>
                  </ToolButton>
                ))}
                {evfCtl && evfCtl.options && evfCtl.options.length > 1 && (
                  <ToolButton
                    active={String(evfCtl.value) !== "1"}
                    onClick={() => {
                      const opts = evfCtl.options!;
                      const i = opts.findIndex((o) => o.value === String(evfCtl.value));
                      const next = opts[(i + 1) % opts.length]!;
                      setZoom(1);
                      void driverRef.current?.setControl?.("evfZoom", next.value).catch((e) => toast.error(e instanceof Error ? e.message : "ההגדלה במצלמה נכשלה"));
                    }}
                    title="הגדלה במצלמה (EVF): אזור מהחיישן בפרטים אמיתיים — חד יותר מהגדלה בתוכנה"
                  >
                    <span>מצלמה{String(evfCtl.value) === "1" ? "" : ` ${evfCtl.options.find((o) => o.value === String(evfCtl.value))?.label ?? ""}`}</span>
                  </ToolButton>
                )}
                <ToolButton active={oneToOne} onClick={() => { setOneToOne((v) => !v); setZoom(1); }} title="1:1 — כל פיקסל של המקור הוא פיקסל במסך (גררו להזזה)">
                  <span className="num">1:1</span>
                </ToolButton>
                <ToolButton active={diagOpen} onClick={() => setDiagOpen((v) => !v)} title="אבחון חדות: רזולוציית המקור, גודל התצוגה ויחס ההגדלה">
                  <span>אבחון</span>
                </ToolButton>
                {choice?.kind === "DIGICAM" && (
                  <ToolButton active={focusZoom} onClick={toggleFocusZoom} title="הגדלת פוקוס במצלמה — אזור מהחיישן בחדות מלאה לבדיקת פוקוס">
                    <Focus />
                    <span>פוקוס חד</span>
                  </ToolButton>
                )}
              </div>
            </div>

            {/* live estimate notices */}
            <div className="pointer-events-none absolute inset-x-0 top-16 flex flex-col items-center gap-1.5 px-3" aria-live="polite">
              {calibrating && (
                <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-[#e8b04b] px-3.5 py-1.5 text-[13px] font-medium text-black">
                  לחצו על הרקע הירוק בתצוגה החיה לכיול
                  <button type="button" className="rounded-full bg-black/15 px-2 py-0.5 text-[12px] hover:bg-black/25" onClick={() => setCalibrating(false)}>
                    ביטול
                  </button>
                </div>
              )}
              {!calibrating && ready && liveStatus?.degraded && processing.liveMode !== "full" && (
                <div className="rounded-full bg-black/60 px-3 py-1 text-[12px] text-studio-muted ring-1 ring-white/10">העיבוד החי איטי במחשב זה — מוצגת מסגרת חיתוך בלבד. העיבוד המלא מתבצע אחרי הצילום.</div>
              )}
              {!calibrating && ready && processing.liveMode !== "full" && lowConfidence && (
                <div className="rounded-full bg-[#4a3a1a]/90 px-3 py-1 text-[12px] text-[#f2d79e] ring-1 ring-white/10" data-testid="live-low-confidence">
                  זיהוי הספר לא בטוח{liveStatus?.warnings.length ? ` — ${liveStatus.warnings.map(warningLabel).join(", ")}` : ""}. השאירו שוליים ירוקים סביב הספר שלא ייגע בקצוות, או התאימו הארה/רגישות — אחרת הצילום יסומן ״לבדיקה״.
                </div>
              )}
            </div>

            {/* category + shutter */}
            <div className="pointer-events-none absolute inset-x-0 bottom-5 grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-4">
              <div className="flex justify-end">
                <div className="pointer-events-auto rounded-full bg-black/60 px-3.5 py-1.5 text-[13.5px] font-medium ring-1 ring-white/10 backdrop-blur-md">
                  {t.category[category]} · <span className="num">{counts[category]}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void trigger()}
                disabled={!ready || diskCritical}
                aria-label="צילום (רווח)"
                title={lowConfidence ? "זיהוי הספר חלש — שפרו מסגור (שוליים ירוקים, הספר לא נוגע בקצוות). אפשר עדיין לצלם (רווח)" : "צילום (רווח)"}
                className={cn(
                  "group pointer-events-auto relative flex size-[80px] items-center justify-center rounded-full border-[3px] transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-40",
                  !ready ? "border-white/40" : lowConfidence ? "border-[#e8b04b] bg-black/20 backdrop-blur-sm" : "border-white bg-black/20 backdrop-blur-sm",
                )}
              >
                <span className={cn("size-[62px] rounded-full transition-all", ready ? "bg-white group-hover:size-[58px] group-active:bg-accent" : "bg-white/50")} />
              </button>
              <div className="flex justify-start">
                <div className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-black/60 px-3.5 py-1.5 text-[12.5px] text-studio-muted ring-1 ring-white/10 backdrop-blur-md">
                  {pendingHere > 0 ? (
                    <>
                      <span className="size-1.5 animate-pulse rounded-full bg-[#e8b04b]" aria-hidden />
                      <span className="num">{pendingHere}</span> בתהליך שמירה
                    </>
                  ) : processingCount > 0 ? (
                    <>
                      <span className="size-1.5 animate-pulse rounded-full bg-[#7fb2e8]" aria-hidden />
                      מעבד <span className="num">{processingCount}</span> תמונות
                    </>
                  ) : (
                    <>
                      <Check className="size-3.5 text-[#3ecf8e]" />
                      הכול נשמר ואומת
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* filmstrip */}
          <div className="h-[140px] shrink-0 border-t border-studio-rule bg-studio-2">
            <Filmstrip
              items={stripItems}
              replaceTarget={replaceTarget}
              onOpen={(i) => setViewerIndex(i)}
              onDelete={deleteAsset}
              onRetake={(it) => {
                setReplaceTarget(it.assetId ?? null);
                if (it.category !== category) setCategory(it.category);
                toast.info(`הצילום הבא יוצע כתחליף לצילום ${it.seq}`, { detail: "הצילום הקודם יישאר עד שתבחרו למחוק אותו." });
              }}
              onPrimary={setPrimary}
              onRetryUpload={(it) => void uploader.retryNow(it.captureId)}
              onEdit={(it) => setEditAsset(ctx.assets.find((a) => a.id === it.assetId) ?? null)}
              canOrganize={user.canOrganize}
              canDelete={user.canDelete}
              showCategory={prefs.filmstripScope === "all"}
            />
          </div>
        </div>
      </div>

      <CameraPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(c) => void connectChoice(c)}
        current={choice ? { kind: choice.kind, id: choice.id } : null}
        agentUrl={prefs.agentUrl}
        simulatorAllowed={simulatorAllowed}
      />

      <ScanOpenDialog open={scanOpen} onClose={() => setScanOpen(false)} onOpen={(id) => switchLot(id)} />

      <CameraSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        connected={conn.state === "ready" || conn.state === "busy"}
        info={info}
        controls={controls}
        onControl={(id, v) => driverRef.current?.setControl(id, v).catch((e) => toast.error(errorMessage(e)))}
        settings={processing}
        onPatch={profile.patchProcessing}
        profiles={profile.profiles}
        activeId={profile.active?.id}
        saving={profile.saving}
        onSelectProfile={profile.select}
        onMakeDefault={() => void profile.makeDefault().then(() => toast.success("הפרופיל הוגדר כברירת מחדל")).catch((e) => toast.error(errorMessage(e)))}
        onCreateProfile={(name) => void profile.create(name).catch((e) => toast.error(errorMessage(e)))}
        onDeleteProfile={(id) => void profile.remove(id).catch((e) => toast.error(errorMessage(e)))}
        onSaveCameraValues={saveCameraValues}
        onCalibrate={() => {
          setSettingsOpen(false);
          setCalibrating(true);
        }}
      />

      <PhotoEditorDialog asset={editAsset} onClose={() => setEditAsset(null)} onSaved={() => refreshAssets()} />

      <Dialog open={advanceOpen} onClose={() => setAdvanceOpen(false)} title={ctx.target === "item" ? `סיום צילום ${ctx.item.inventoryNumber}` : `סיום פריט ${ctx.lot.lotNumber}`} width="sm">
        <div className="space-y-3 text-[13.5px]">
          <p>
            הפריט יסומן <strong>{t.lotStatus[prefs.completeStatus]}</strong>.
          </p>
          <ul className="divide-y divide-rule rounded-lg border border-rule">
            {PHOTO_CATEGORIES.map((c) => (
              <li key={c} className="flex justify-between px-3 py-2">
                <span>{t.category[c]}</span>
                <span className={cn("num font-medium", !counts[c] && "text-faint")}>{counts[c]}</span>
              </li>
            ))}
          </ul>
          {pendingHere > 0 && <p className="text-warn">{pendingHere} צילומים עדיין בתהליך העלאה — הם ימשיכו להעלות ברקע וישויכו לפריט זה.</p>}
          {ctx.next ? (
            prefs.continuous ? (
              <p className="text-ink-2">
                אחר כך: פריט <span className="num font-medium">{ctx.next.lotNumber}</span> · {ctx.next.title}. המצלמה נשארת מחוברת.
              </p>
            ) : (
              <p className="text-muted">צילום רציף כבוי — תישארו בפריט זה. מעבר לפריט הבא בכפתור או במקש {keyLabel(prefs.nextLotKey)}.</p>
            )
          ) : (
            <p className="text-muted">זהו הפריט האחרון בקטלוג.</p>
          )}
        </div>
        <div className="mt-6 flex gap-2">
          <Button variant="primary" loading={completing} onClick={completeLot} autoFocus>
            {ctx.next && prefs.continuous ? "סיום ומעבר לפריט הבא" : "סיום הפריט"}
          </Button>
          {user.canCreate && (
            <Button
              onClick={() => {
                setAdvanceOpen(false);
                setNewBook("finish");
              }}
            >
              סיים ספר וצור חדש
            </Button>
          )}
          <Button onClick={() => setAdvanceOpen(false)}>ביטול</Button>
        </div>
      </Dialog>

      <NewBookDialog
        open={newBook !== null}
        onClose={() => setNewBook(null)}
        target={ctx.target === "lot" ? { kind: "catalog", catalogId: ctx.catalog.id, catalogLabel: `${ctx.catalog.number} · ${ctx.catalog.name}` } : { kind: "inventory" }}
        finishing={newBook === "finish" ? { label: ctx.target === "item" ? ctx.item.inventoryNumber : `פריט ${ctx.lot.lotNumber}`, statusLabel: t.lotStatus[prefs.completeStatus] } : null}
        waitDurable={waitDurable}
        onFinish={newBook === "finish" ? markComplete : undefined}
        onCreated={async (id) => {
          await switchLot(id, "COVER");
          toast.success("עברנו לספר החדש", { detail: "קטגוריה: כריכה" });
        }}
      />

      {viewerIndex !== null && <ImageViewer items={viewerItems} index={viewerIndex} onIndex={setViewerIndex} onClose={() => setViewerIndex(null)} />}
    </div>
  );
}

function SectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mb-2 px-1 text-[12px] font-medium text-studio-muted", className)}>{children}</div>;
}

function StudioIcon({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button type="button" className="rounded-md p-2 text-studio-muted transition-colors hover:bg-studio-3 hover:text-studio-text [&_svg]:size-4.5" onClick={onClick} title={title} aria-label={title}>
      {children}
    </button>
  );
}

function ToolButton({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] transition-colors [&_svg]:size-4",
        active ? "bg-white text-studio" : "text-white/80 hover:bg-white/10 hover:text-white",
      )}
    >
      {children}
    </button>
  );
}
