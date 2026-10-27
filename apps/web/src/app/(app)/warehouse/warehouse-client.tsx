"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Tag } from "lucide-react";
import { BOOK_SIZES, formatLocationCode } from "@avot/shared";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Panel } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { t } from "@/i18n";
import { api, errorMessage } from "@/lib/api";

export function ShelfLabelButton({ ids }: { ids: string[] }) {
  const router = useRouter();
  return (
    <button type="button" onClick={() => router.push(`/labels/locations?ids=${ids.join(",")}`)} className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted hover:bg-stone hover:text-ink" title="הדפסת תוויות למדף">
      <Tag className="size-3.5" /> תוויות
    </button>
  );
}

interface Tree {
  id: string;
  name: string;
  code: string;
  zones: { id: string; code: string; name: string; shelves: { id: string; code: string }[] }[];
}

/** Building the warehouse hierarchy: zone → shelf → cells (bulk range). Codes become the printed barcodes. */
export function WarehouseEditor({ warehouses }: { warehouses: Tree[] }) {
  const router = useRouter();
  const toast = useToast();
  const [whId, setWhId] = useState(warehouses[0]?.id ?? "");
  const wh = warehouses.find((w) => w.id === whId) ?? warehouses[0];
  const zones = wh?.zones ?? [];
  const [zoneId, setZoneId] = useState(zones[0]?.id ?? "");
  const shelves = zones.find((z) => z.id === zoneId)?.shelves ?? [];
  const [shelfId, setShelfId] = useState(shelves[0]?.id ?? "");
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key);
    try {
      toast.success(await fn());
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const zone = zones.find((z) => z.id === zoneId);
  const shelf = shelves.find((s) => s.id === shelfId);

  return (
    <Panel title="מבנה המחסן">
      <div className="space-y-5 px-5 py-4">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const form = e.currentTarget;
            void run("warehouse", async () => {
              const r = await api<{ warehouse: { id: string; code: string } }>("/api/warehouse", { method: "POST", json: { code: f.get("code"), name: f.get("name") } });
              setWhId(r.warehouse.id);
              form.reset();
              return `נוצר מחסן ${r.warehouse.code}`;
            });
          }}
        >
          <Field label="מחסן חדש — קוד">
            {(p) => <Input {...p} name="code" required maxLength={8} dir="ltr" className="w-24 font-mono uppercase" placeholder="MAIN" />}
          </Field>
          <Field label="שם" className="flex-1">
            {(p) => <Input {...p} name="name" required maxLength={100} placeholder="מחסן ראשי" />}
          </Field>
          <Button type="submit" icon={<Plus />} loading={busy === "warehouse"} aria-label="הוספת מחסן" />
        </form>

        {warehouses.length > 1 && (
          <Field label="מחסן פעיל">
            {(p) => (
              <Select
                {...p}
                value={whId}
                onChange={(e) => {
                  setWhId(e.target.value);
                  const w = warehouses.find((x) => x.id === e.target.value);
                  setZoneId(w?.zones[0]?.id ?? "");
                  setShelfId(w?.zones[0]?.shelves[0]?.id ?? "");
                }}
              >
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.code})
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        {warehouses.length === 0 ? (
          <p className="text-[13px] text-muted">צרו מחסן ראשון כדי להוסיף אזורים, מדפים ותאים.</p>
        ) : (
        <>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const form = e.currentTarget;
            void run("zone", async () => {
              const r = await api<{ zone: { id: string; code: string } }>("/api/warehouse/zones", { method: "POST", json: { warehouseId: wh?.id, code: f.get("code"), name: f.get("name") || undefined } });
              setZoneId(r.zone.id);
              form.reset();
              return `נוצר אזור ${r.zone.code}`;
            });
          }}
        >
          <Field label="אזור חדש — קוד">
            {(p) => <Input {...p} name="code" required maxLength={4} dir="ltr" className="w-20 font-mono uppercase" placeholder="A" />}
          </Field>
          <Field label="שם" className="flex-1">
            {(p) => <Input {...p} name="name" maxLength={100} placeholder="אזור A" />}
          </Field>
          <Button type="submit" icon={<Plus />} loading={busy === "zone"} aria-label="הוספת אזור" />
        </form>

        {zones.length > 0 && (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const form = e.currentTarget;
              void run("shelf", async () => {
                const r = await api<{ shelf: { id: string; code: string } }>("/api/warehouse/shelves", { method: "POST", json: { zoneId, code: f.get("code"), shelfType: f.get("shelfType") || null } });
                setShelfId(r.shelf.id);
                form.reset();
                return `נוצר מדף ${r.shelf.code}`;
              });
            }}
          >
            <Field label="אזור">
              {(p) => (
                <Select {...p} value={zoneId} onChange={(e) => { setZoneId(e.target.value); setShelfId(zones.find((z) => z.id === e.target.value)?.shelves[0]?.id ?? ""); }} className="w-24">
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.code}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="מדף — קוד">
              {(p) => <Input {...p} name="code" required maxLength={4} dir="ltr" className="w-20 font-mono" placeholder="03" />}
            </Field>
            <Field label="סוג" className="flex-1">
              {(p) => <Input {...p} name="shelfType" maxLength={100} placeholder="מדף פתוח / ארון / מגירה" />}
            </Field>
            <Button type="submit" icon={<Plus />} loading={busy === "shelf"} aria-label="הוספת מדף" />
          </form>
        )}

        {shelves.length > 0 && (
          <form
            className="grid grid-cols-2 gap-x-2 gap-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const num = (k: string) => (f.get(k) ? Number(f.get(k)) : undefined);
              void run("locs", async () => {
                const r = await api<{ locations: { code: string }[] }>("/api/warehouse/locations", {
                  method: "POST",
                  json: { shelfId, from: num("from"), to: num("to"), sizeClass: f.get("sizeClass") || null, capacity: num("capacity") ?? null },
                });
                return `נוצרו ${r.locations.length} מיקומים: ${r.locations[0]?.code}${r.locations.length > 1 ? ` … ${r.locations[r.locations.length - 1]?.code}` : ""}`;
              });
            }}
          >
            <Field label="מדף">
              {(p) => (
                <Select {...p} value={shelfId} onChange={(e) => setShelfId(e.target.value)}>
                  {shelves.map((s) => (
                    <option key={s.id} value={s.id}>
                      {zone?.code}-{s.code}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="flex items-end gap-1.5">
              <Field label="תאים מ־">
                {(p) => <Input {...p} name="from" type="number" min={0} max={999} required defaultValue={1} className="num w-16" />}
              </Field>
              <Field label="עד">
                {(p) => <Input {...p} name="to" type="number" min={0} max={999} required defaultValue={6} className="num w-16" />}
              </Field>
            </div>
            <Field label="גודל ספרים מתאים">
              {(p) => (
                <Select {...p} name="sizeClass" defaultValue="">
                  <option value="">כל הגדלים</option>
                  {BOOK_SIZES.filter((s) => s !== "UNKNOWN").map((s) => (
                    <option key={s} value={s}>
                      {t.bookSize[s]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="קיבולת מומלצת">
              {(p) => <Input {...p} name="capacity" type="number" min={1} max={10000} className="num" placeholder="ספרים" />}
            </Field>
            <p className="col-span-2 text-[12px] text-muted" dir="rtl">
              קוד לדוגמה: <span className="num font-mono">{zone && shelf ? formatLocationCode({ zone: zone.code, shelf: shelf.code, cell: "02" }) : "LOC-A-03-02"}</span>
            </p>
            <Button type="submit" variant="primary" icon={<Plus />} loading={busy === "locs"} className="col-span-2">
              יצירת מיקומים
            </Button>
          </form>
        )}
        </>
        )}
      </div>
    </Panel>
  );
}
