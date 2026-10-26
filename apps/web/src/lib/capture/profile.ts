"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_PROCESSING, type CameraProfileSettings, type ProcessingSettings } from "@avot/shared";
import { api } from "@/lib/api";
import type { CameraProfileDto } from "@/server/services/camera-profiles";

/**
 * The active camera profile: processing settings (rotation, background, crop …) and the
 * camera control values to restore. Changes apply immediately in the UI and are saved to the
 * server shortly after, so the profile is the same on the next visit and on every station.
 * The capture screen keeps working with the built-in defaults when the profile API is unreachable.
 */
export function useCaptureProfile(activeId: string | null, onActiveChange: (id: string | null) => void) {
  const [profiles, setProfiles] = useState<CameraProfileDto[] | null>(null);
  const [saving, setSaving] = useState(false);
  const latest = useRef<CameraProfileDto[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef<string | null>(null);
  latest.current = profiles;

  const load = useCallback(async () => {
    try {
      const r = await api<{ profiles: CameraProfileDto[] }>("/api/camera-profiles");
      setProfiles(r.profiles);
    } catch {
      setProfiles((p) => p ?? []);
    }
  }, []);

  useEffect(() => void load(), [load]);

  const active = profiles?.find((p) => p.id === activeId) ?? profiles?.find((p) => p.isDefault) ?? profiles?.[0] ?? null;
  const settings: CameraProfileSettings = active?.settings ?? { processing: DEFAULT_PROCESSING, camera: {} };

  const flush = useCallback(async () => {
    const id = dirty.current;
    if (!id) return;
    dirty.current = null;
    const p = latest.current?.find((x) => x.id === id);
    if (!p) return;
    setSaving(true);
    try {
      await api(`/api/camera-profiles/${id}`, { method: "PATCH", json: { settings: p.settings } });
    } finally {
      setSaving(false);
    }
  }, []);

  const mutate = useCallback(
    (fn: (s: CameraProfileSettings) => CameraProfileSettings) => {
      if (!active) return;
      const id = active.id;
      setProfiles((list) => (list ?? []).map((p) => (p.id === id ? { ...p, settings: fn(p.settings) } : p)));
      dirty.current = id;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush().catch(() => undefined), 600);
    },
    [active, flush],
  );

  const patchProcessing = useCallback((patch: Partial<ProcessingSettings>) => mutate((s) => ({ ...s, processing: { ...s.processing, ...patch } })), [mutate]);
  const setCameraValues = useCallback((camera: Record<string, string | number | boolean>) => mutate((s) => ({ ...s, camera })), [mutate]);

  const select = useCallback((id: string) => onActiveChange(id), [onActiveChange]);

  const makeDefault = useCallback(async () => {
    if (!active) return;
    await flush();
    await api(`/api/camera-profiles/${active.id}`, { method: "PATCH", json: { isDefault: true } });
    await load();
  }, [active, flush, load]);

  const create = useCallback(
    async (name: string) => {
      const r = await api<{ profile: CameraProfileDto }>("/api/camera-profiles", { method: "POST", json: { name, settings: active?.settings ?? { processing: DEFAULT_PROCESSING, camera: {} } } });
      await load();
      onActiveChange(r.profile.id);
    },
    [active, load, onActiveChange],
  );

  const remove = useCallback(
    async (id: string) => {
      await api(`/api/camera-profiles/${id}`, { method: "DELETE" });
      if (activeId === id) onActiveChange(null);
      await load();
    },
    [activeId, load, onActiveChange],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      void flush().catch(() => undefined);
    },
    [flush],
  );

  return { profiles, active, settings, saving, patchProcessing, setCameraValues, select, makeDefault, create, remove, flush, ready: profiles !== null };
}
