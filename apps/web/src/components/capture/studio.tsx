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
} from "lucide-react";
import { PHOTO_CATEGORIES, type CaptureStage, type PhotoCategory } from "@avot/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/field";
import { Kbd } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { ImageViewer, assetViewerDetails, type ViewerItem } from "@/components/image-viewer";
import { OutboxIndicator } from "@/components/shell/outbox-indicator";
import { fmt, t } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { outbox, sha256Hex, storageHealth, type OutboxEntry, type StorageHealth } from "@/lib/capture/outbox";
import { uploader } from "@/lib/capture/uploader";
import { DEFAULT_PREFS, isTypingTarget, keyLabel, mergePrefs, playShutter, savePrefs, type CapturePrefs } from "@/lib/capture/prefs";
import type { CameraControl, CameraDriver, CameraInfo, CaptureContext, ConnectionState } from "@/lib/capture/drivers/types";
import { WebcamDriver } from "@/lib/capture/drivers/webcam";
import { SimulatorDriver } from "@/lib/capture/drivers/simulator";
import { AgentDriver } from "@/lib/capture/drivers/agent";
import type { AssetDto } from "@/server/services/asset-dto";
import type { CaptureLotContext } from "@/server/services/capture-context";
import { CameraPicker, type CameraChoice } from "./camera-picker";
import { Filmstrip, type StripItem } from "./filmstrip";
import { LiveView } from "./live-view";
import { ScanOpenDialog } from "./scan-open-dialog";

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
  ready: "מוכן לצילום",
  busy: "המצלמה עסוקה",
  disconnected: "מנותק",
  error: "שגיאה",
};

const KIND_LABEL = { WEBCAM: "מצלמת רשת", SIMULATOR: "סימולטור", CANON: "Canon EDSDK", AGENT_SIMULATOR: "סימולטור Agent" } as const;

export function CaptureStudio({
  user,
  initialContext,
  initialCategory,
  serverPrefs,
  simulatorAllowed,
}: {
  user: { id: string; name: string; canOrganize: boolean; canStatus: boolean; canDelete: boolean };
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
  const lastTrigger = useRef(0);
  const [flashKey, setFlashKey] = useState(0);
  const [replaceTarget, setReplaceTarget] = useState<string | null>(null);
  const replaceRef = useRef<string | null>(null);
  replaceRef.current = replaceTarget;
  const pendingReplace = useRef(new Map<string, string>()); // new captureId → old assetId

  // ── view ───────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [peaking, setPeaking] = useState(false);
  const [hidePanels, setHidePanels] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [health, setHealth] = useState<StorageHealth>({ freeBytes: null, level: "ok" });
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [completing, setCompleting] = useState(false);

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
        setPrefs({ lastCamera: { kind: c.kind, id: c.id, label: c.label } });
        const cur = ctxRef.current;
        await driver.setActiveContext?.({
          lotId: cur.lot.id,
          catalogId: cur.catalog.id,
          category: categoryRef.current,
          lotNumber: cur.lot.lotNumber,
          catalogNumber: cur.catalog.number,
        });
        const s = await api<{ session: { id: string } }>("/api/capture-sessions", {
          method: "POST",
          json: {
            lotId: cur.lot.id,
            category: categoryRef.current,
            cameraKind: c.kind,
            cameraName: driver.info().name,
            deviceId: c.kind === "CANON" || c.kind === "AGENT_SIMULATOR" ? c.id : null,
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
    else setPickerOpen(true);
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
      ?.setActiveContext?.({ lotId, catalogId: c.catalog.id, category: cat, lotNumber: c.lot.lotNumber, catalogNumber: c.catalog.number })
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
      else if (e.code === "KeyR") setRotation((r) => (r + 90) % 360);
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
  }, [trigger, setCategory, switchLot, setPrefs, viewerIndex]);

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

  // ── lot completion / continuous mode ───────────────────────────
  async function completeLot() {
    setCompleting(true);
    try {
      // the photo status belongs to the book; a catalog lot mirrors it
      if (ctx.target === "item") await api(`/api/inventory/${ctx.item.id}`, { method: "PATCH", json: { photoStatus: prefs.completeStatus } });
      else await api(`/api/lots/${ctx.lot.id}`, { method: "PATCH", json: { status: prefs.completeStatus } });
      setCtx((c) => ({ ...c, lot: { ...c.lot, status: prefs.completeStatus } }));
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
    return {
      key: it.key,
      title: `${ctx.target === "item" ? ctx.item.inventoryNumber : `פריט ${ctx.lot.lotNumber}`} · ${t.category[it.category]} · צילום ${it.seq ?? "—"}`,
      src: asset?.previewUrl ?? it.src,
      originalSrc: asset ? `/api/assets/${asset.id}/original` : it.src,
      downloadHref: asset ? `/api/assets/${asset.id}/original?download=1` : null,
      rotation: it.rotation,
      details: d?.details ?? [{ label: "מצב", value: t.uploadStage[it.stage] }],
      warnings: d?.warnings,
    };
  });

  const ready = conn.state === "ready";
  const isAgent = choice?.kind === "CANON" || choice?.kind === "AGENT_SIMULATOR";
  const agentQueue = isAgent ? (driverRef.current as AgentDriver | null)?.queueStatus?.() : null;
  const diskCritical = isAgent ? agentQueue?.disk.level === "critical" : health.level === "critical";

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
          <StudioIcon onClick={() => setScanOpen(true)} title="פתיחת ספר בסריקת ברקוד">
            <ScanLine />
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
            <span className="hidden text-studio-muted md:inline">{STATE_LABEL[conn.state]}</span>
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
              peaking={peaking}
              onPeakingUnavailable={() => {
                setPeaking(false);
                toast.warning("הדגשת פוקוס אינה זמינה במצלמה זו");
              }}
              flashKey={flashKey}
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
                  </div>
                </div>
              )}
            </LiveView>

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
                <ToolButton active={rotation !== 0} onClick={() => setRotation((r) => (r + 90) % 360)} title="סיבוב התצוגה (R)">
                  <RotateCw />
                  {rotation !== 0 && <span className="num">{rotation}°</span>}
                </ToolButton>
                <span className="mx-1 h-5 w-px bg-white/15" aria-hidden />
                {[1, 2, 4].map((z) => (
                  <ToolButton key={z} active={zoom === z} onClick={() => setZoom(z)} title="הגדלה לבדיקת פוקוס (Z)">
                    <span className="num">{z}×</span>
                  </ToolButton>
                ))}
              </div>
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
                title="צילום (רווח)"
                className={cn(
                  "group pointer-events-auto relative flex size-[80px] items-center justify-center rounded-full border-[3px] transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-40",
                  ready ? "border-white bg-black/20 backdrop-blur-sm" : "border-white/40",
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
          <Button onClick={() => setAdvanceOpen(false)}>ביטול</Button>
        </div>
      </Dialog>

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

function ControlRow({ control: c, onChange }: { control: CameraControl; onChange: (v: number | string | boolean) => void }) {
  const [local, setLocal] = useState(c.value);
  useEffect(() => setLocal(c.value), [c.value]);
  if (c.type === "action") {
    return (
      <Button size="sm" variant="studio" onClick={() => onChange(true)} className="w-full">
        {c.label}
      </Button>
    );
  }
  if (c.type === "toggle") {
    return (
      <Switch
        tone="studio"
        label={<span className="text-studio-muted">{c.label}</span>}
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
        <span className="text-studio-muted">{c.label}</span>
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
          className="w-full accent-[#ededea]"
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
          className="h-9 w-full rounded-md border border-studio-rule bg-studio-3 px-2 text-[13px] text-studio-text"
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
