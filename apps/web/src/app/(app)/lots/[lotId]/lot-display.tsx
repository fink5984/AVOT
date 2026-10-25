"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, RotateCcw, Star } from "lucide-react";
import { PHOTO_CATEGORIES, type PhotoCategory } from "@avot/shared";
import { Button, IconButton } from "@/components/ui/button";
import { Panel } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { t } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { AssetDto } from "@/server/services/asset-dto";

/**
 * How THIS catalog shows the book's photos: its own order, hidden photos and
 * primary photo. The source photos (and their master order) belong to the
 * book and are shared by every catalog it is assigned to — nothing is copied.
 */
export function LotDisplayPanel({ lotId, canEdit }: { lotId: string; canEdit: boolean }) {
  const toast = useToast();
  const [shown, setShown] = useState<AssetDto[]>([]);
  const [all, setAll] = useState<AssetDto[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [lot, master] = await Promise.all([api<{ assets: AssetDto[] }>(`/api/lots/${lotId}/assets?scope=lot`), api<{ assets: AssetDto[] }>(`/api/lots/${lotId}/assets`)]);
    setShown(lot.assets);
    setAll(master.assets);
  }, [lotId]);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const move = (cat: PhotoCategory, id: string, dir: -1 | 1) => {
    const list = shown.filter((a) => a.category === cat).map((a) => a.id);
    const i = list.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    void run(() => api("/api/assets/reorder", { method: "POST", json: { lotId, category: cat, orderedIds: list, scope: "lot" } }));
  };
  const hidden = all.filter((a) => !shown.some((s) => s.id === a.id));

  return (
    <Panel title="תצוגה בקטלוג זה">
      <div className="px-4 py-3">
        <p className="text-[12px] text-muted">סדר, הסתרה ותמונה ראשית לקטלוג זה בלבד. תמונות המקור שייכות לספר ומשותפות לכל הקטלוגים.</p>
        {PHOTO_CATEGORIES.map((cat) => {
          const list = shown.filter((a) => a.category === cat);
          if (!list.length) return null;
          return (
            <div key={cat} className="mt-3">
              <div className="mb-1 text-[12px] font-medium text-ink-2">{t.category[cat]}</div>
              <ol className="space-y-1">
                {list.map((a, i) => (
                  <li key={a.id} className="flex items-center gap-2">
                    <span className={cn("block size-10 shrink-0 overflow-hidden rounded bg-stone ring-1", a.isPrimary ? "ring-2 ring-accent" : "ring-rule")}>
                      {a.thumbUrl && <img src={a.thumbUrl} alt="" className="size-full object-cover" style={{ transform: `rotate(${a.rotation}deg)` }} />}
                    </span>
                    <span className="num text-[12px] text-muted">{i + 1}</span>
                    {canEdit && (
                      <span className="ms-auto flex items-center">
                        <IconButton size="sm" label="למעלה" disabled={busy || i === 0} onClick={() => move(cat, a.id, -1)}>
                          <ArrowUp />
                        </IconButton>
                        <IconButton size="sm" label="למטה" disabled={busy || i === list.length - 1} onClick={() => move(cat, a.id, 1)}>
                          <ArrowDown />
                        </IconButton>
                        <IconButton size="sm" label="תמונה ראשית בקטלוג זה" disabled={busy || a.isPrimary} onClick={() => run(() => api(`/api/assets/${a.id}/primary?lotId=${lotId}`, { method: "POST" }))}>
                          <Star className={a.isPrimary ? "fill-accent text-accent" : ""} />
                        </IconButton>
                        <IconButton size="sm" label="הסתרה בקטלוג זה" disabled={busy} onClick={() => run(() => api(`/api/lots/${lotId}/display`, { method: "POST", json: { assetId: a.id, hidden: true } }))}>
                          <EyeOff />
                        </IconButton>
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          );
        })}
        {hidden.length > 0 && (
          <div className="mt-3 border-t border-rule pt-3">
            <div className="mb-1 text-[12px] font-medium text-muted">מוסתרות בקטלוג זה ({hidden.length})</div>
            <div className="flex flex-wrap gap-1.5">
              {hidden.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  disabled={!canEdit || busy}
                  onClick={() => run(() => api(`/api/lots/${lotId}/display`, { method: "POST", json: { assetId: a.id, hidden: false } }))}
                  className="relative size-10 overflow-hidden rounded bg-stone opacity-50 ring-1 ring-rule hover:opacity-100"
                  title="הצגה בקטלוג זה"
                >
                  {a.thumbUrl && <img src={a.thumbUrl} alt="" className="size-full object-cover" />}
                  <Eye className="absolute inset-0 m-auto size-4 text-white drop-shadow" />
                </button>
              ))}
            </div>
          </div>
        )}
        {canEdit && (
          <Button size="sm" variant="ghost" className="mt-3" icon={<RotateCcw />} disabled={busy} onClick={() => run(() => api(`/api/lots/${lotId}/display`, { method: "POST", json: { reset: true } }))}>
            חזרה לסדר של הספר
          </Button>
        )}
      </div>
    </Panel>
  );
}
