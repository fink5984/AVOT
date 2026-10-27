"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, ChevronLeft, ChevronRight, MoreHorizontal, Pencil, Plus, Power, Printer, Rows3, Warehouse as WarehouseIcon } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { Menu } from "@/components/ui/menu";
import { EmptyState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { LocationDialog } from "@/components/warehouse/location-dialog";
import { usePrintLabels } from "@/lib/print";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";

export interface ShelfDto {
  id: string;
  code: string;
  active: boolean;
  books: number;
  locationIds: string[];
}
export interface ColumnDto {
  id: string;
  code: string;
  name: string;
  shelves: ShelfDto[];
}
export interface WarehouseDto {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
  zones: ColumnDto[];
}

const num = (code: string) => (/^\d+$/.test(code) ? String(Number(code)) : code);

/**
 * Warehouse → column → shelf as a picture: columns side by side, the shelves of each column stacked, each
 * shelf showing how many books it holds. A click opens the shelf's books. Sizes adapt (the grid wraps) so a
 * 40-shelf warehouse and a 400-shelf one use the same screen.
 */
export function WarehouseStructure({ warehouses, perms }: { warehouses: WarehouseDto[]; perms: { manage: boolean; print: boolean; relocate: boolean } }) {
  const router = useRouter();
  const toast = useToast();
  const print = usePrintLabels();
  const [activeId, setActiveId] = useState(warehouses[0]?.id ?? "");
  const [wizard, setWizard] = useState(false);
  const [shelfId, setShelfId] = useState<string | null>(null);
  const [rename, setRename] = useState<{ kind: "warehouse" | "column"; id: string; name: string } | null>(null);
  const [addShelves, setAddShelves] = useState<ColumnDto | null>(null);
  const wh = warehouses.find((w) => w.id === activeId) ?? warehouses[0];
  useEffect(() => {
    if (!warehouses.some((w) => w.id === activeId)) setActiveId(warehouses[0]?.id ?? "");
  }, [warehouses, activeId]);

  const totals = useMemo(() => {
    const shelves = wh?.zones.flatMap((z) => z.shelves) ?? [];
    return { columns: wh?.zones.length ?? 0, shelves: shelves.length, books: shelves.reduce((a, s) => a + s.books, 0) };
  }, [wh]);

  async function addColumn() {
    if (!wh) return;
    const shelves = wh.zones.at(-1)?.shelves.length ?? 5;
    try {
      await api("/api/warehouse/columns", { method: "POST", json: { warehouseId: wh.id, shelves } });
      toast.success("נוספה עמודה", { detail: `${shelves} מדפים עם ברקודים` });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function move(col: ColumnDto, dir: -1 | 1) {
    if (!wh) return;
    const ids = wh.zones.map((z) => z.id);
    const i = ids.indexOf(col.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    try {
      await api("/api/warehouse/reorder", { method: "POST", json: { kind: "columns", parentId: wh.id, orderedIds: ids } });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {warehouses.length > 1 && (
          <div role="tablist" aria-label="מחסן" className="flex gap-0.5 rounded-lg bg-stone p-0.5">
            {warehouses.map((w) => (
              <button key={w.id} role="tab" aria-selected={w.id === wh?.id} onClick={() => setActiveId(w.id)} className={cn("h-8 rounded-md px-3 text-[13.5px] font-medium", w.id === wh?.id ? "bg-paper shadow-card ring-1 ring-rule" : "text-ink-2 hover:text-ink")}>
                {w.name}
              </button>
            ))}
          </div>
        )}
        {wh && (
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <span className="text-[15px] font-semibold text-ink">{wh.name}</span>
            <span>
              <span className="num">{totals.columns}</span> עמודות · <span className="num">{totals.shelves}</span> מדפים · <span className="num">{totals.books}</span> ספרים
            </span>
          </div>
        )}
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {perms.print && wh && totals.shelves > 0 && (
            <Button size="sm" icon={<Printer />} onClick={() => void print([], { warehouseId: wh.id, what: "תוויות המחסן" })}>
              הדפסת כל תוויות המחסן
            </Button>
          )}
          {perms.manage && wh && (
            <Menu
              trigger={(p) => (
                <IconButton label="פעולות למחסן" size="sm" {...p}>
                  <MoreHorizontal />
                </IconButton>
              )}
              items={[{ label: "שינוי שם המחסן", icon: <Pencil />, onSelect: () => setRename({ kind: "warehouse", id: wh.id, name: wh.name }) }]}
            />
          )}
          {perms.manage && (
            <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setWizard(true)}>
              מחסן חדש
            </Button>
          )}
        </div>
      </div>

      {!wh ? (
        <div className="card">
          <EmptyState icon={<WarehouseIcon />} title="עדיין לא הוגדר מחסן" action={perms.manage && <Button variant="primary" icon={<Plus />} onClick={() => setWizard(true)}>הקמת מחסן</Button>}>
            נותנים שם, בוחרים כמה עמודות וכמה מדפים בכל עמודה, והמערכת יוצרת את כל המדפים והברקודים.
          </EmptyState>
        </div>
      ) : (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]">
          {wh.zones.map((z, idx) => (
            <div key={z.id} className="card flex min-w-0 flex-col overflow-hidden">
              <div className="flex items-center gap-1 border-b border-rule bg-stone-2 py-1.5 ps-3 pe-1.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-semibold">{z.name}</div>
                  <div className="num text-[11.5px] text-muted">
                    {z.shelves.length} מדפים · {z.shelves.reduce((a, s) => a + s.books, 0)} ספרים
                  </div>
                </div>
                {(perms.print || perms.manage) && (
                  <Menu
                    trigger={(p) => (
                      <IconButton label={`פעולות ל${z.name}`} size="sm" {...p}>
                        <MoreHorizontal />
                      </IconButton>
                    )}
                    items={[
                      ...(perms.print
                        ? [
                            { label: "הדפסת תווית עמודה", icon: <Printer />, onSelect: () => void print([{ type: "ZONE", id: z.id }], { what: `תווית ${z.name}` }) },
                            { label: "הדפסת כל המדפים בעמודה", icon: <Rows3 />, onSelect: () => void print([], { zoneId: z.id, what: `תוויות ${z.name}` }) },
                          ]
                        : []),
                      ...(perms.manage
                        ? ([
                            "separator",
                            { label: "הוספת מדפים", icon: <Plus />, onSelect: () => setAddShelves(z) },
                            { label: "שינוי שם", icon: <Pencil />, onSelect: () => setRename({ kind: "column", id: z.id, name: z.name }) },
                            { label: "הזזה ימינה", icon: <ChevronRight />, disabled: idx === 0, onSelect: () => void move(z, -1) },
                            { label: "הזזה שמאלה", icon: <ChevronLeft />, disabled: idx === wh.zones.length - 1, onSelect: () => void move(z, 1) },
                          ] as const)
                        : []),
                    ]}
                  />
                )}
              </div>
              <ul className="max-h-[420px] space-y-1 overflow-y-auto p-2">
                {z.shelves.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setShelfId(s.id)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-[13px] ring-1 transition-colors",
                        !s.active ? "bg-stone text-faint ring-rule line-through" : s.books ? "bg-green-soft text-green-2 ring-green/20 hover:bg-green-soft/70" : "bg-paper text-ink-2 ring-rule hover:bg-stone-2",
                      )}
                      title={s.locationIds.length === 0 ? "" : undefined}
                    >
                      <span>
                        מדף <span className="num font-semibold">{num(s.code)}</span>
                      </span>
                      <span className="num text-[12px]">{s.books}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {perms.manage && (
            <button type="button" onClick={addColumn} className="flex min-h-24 items-center justify-center gap-2 rounded-xl border-2 border-dashed border-rule-strong text-[13.5px] text-muted hover:border-ink/30 hover:bg-stone-2 hover:text-ink">
              <Plus className="size-4" /> הוספת עמודה
            </button>
          )}
        </div>
      )}

      <WizardDialog open={wizard} onClose={() => setWizard(false)} />
      <RenameDialog state={rename} onClose={() => setRename(null)} />
      <AddShelvesDialog column={addShelves} onClose={() => setAddShelves(null)} />
      <ShelfPanel shelfId={shelfId} onClose={() => setShelfId(null)} perms={perms} warehouses={warehouses} />
    </section>
  );
}

function WizardDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [columns, setColumns] = useState(8);
  const [shelves, setShelves] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setError(null);
      setName("");
    }
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/warehouse/wizard", { method: "POST", json: { name, columns, shelvesPerColumn: shelves } });
      toast.success("המחסן הוקם", { detail: `${columns * shelves} מדפים עם מספור וברקודים. אפשר להדפיס את התוויות מכאן.` });
      onClose();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const clamp = (v: string) => Math.max(1, Math.min(99, Number(v) || 1));
  return (
    <Dialog open={open} onClose={onClose} title="מחסן חדש" description="שם, כמה עמודות, וכמה מדפים בכל עמודה. השאר נוצר אוטומטית." width="sm">
      <form onSubmit={submit} className="space-y-3.5">
        <Field label="שם המחסן" required>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={100} placeholder="למשל: מחסן 1" />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="מספר עמודות">{(p) => <Input {...p} type="number" min={1} max={99} inputMode="numeric" value={columns} onChange={(e) => setColumns(clamp(e.target.value))} className="num" />}</Field>
          <Field label="מדפים בכל עמודה">{(p) => <Input {...p} type="number" min={1} max={99} inputMode="numeric" value={shelves} onChange={(e) => setShelves(clamp(e.target.value))} className="num" />}</Field>
        </div>
        <p className="rounded-md bg-stone px-3 py-2 text-[13px] text-ink-2">
          ייווצרו <b className="num">{columns}</b> עמודות ו-<b className="num">{columns * shelves}</b> מדפים, כל אחד עם מיקום וברקוד סריק.
        </p>
        {error && (
          <p className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
            הקמת מחסן
          </Button>
          <Button onClick={onClose}>ביטול</Button>
        </div>
      </form>
    </Dialog>
  );
}

function RenameDialog({ state, onClose }: { state: { kind: "warehouse" | "column"; id: string; name: string } | null; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(state?.name ?? ""), [state]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!state) return;
    setBusy(true);
    try {
      await api(state.kind === "warehouse" ? `/api/warehouse/${state.id}` : `/api/warehouse/columns/${state.id}`, { method: "PATCH", json: { name } });
      toast.success("השם עודכן", { detail: "קודי המיקומים והברקודים שהודפסו לא השתנו" });
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={!!state} onClose={onClose} title={state?.kind === "warehouse" ? "שינוי שם מחסן" : "שינוי שם עמודה"} width="sm">
      <form onSubmit={submit} className="space-y-3.5">
        <Field label="שם">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={100} />}</Field>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
            שמירה
          </Button>
          <Button onClick={onClose}>ביטול</Button>
        </div>
      </form>
    </Dialog>
  );
}

function AddShelvesDialog({ column, onClose }: { column: ColumnDto | null; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!column) return;
    setBusy(true);
    try {
      await api(`/api/warehouse/columns/${column.id}/shelves`, { method: "POST", json: { count } });
      toast.success(`נוספו ${count} מדפים ל${column.name}`);
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={!!column} onClose={onClose} title={`הוספת מדפים · ${column?.name ?? ""}`} width="sm">
      <form onSubmit={submit} className="space-y-3.5">
        <Field label="כמה מדפים להוסיף" hint="המדפים החדשים ממוספרים אחרי האחרון, והקיימים לא משתנים.">
          {(p) => <Input {...p} type="number" min={1} max={99} value={count} onChange={(e) => setCount(Math.max(1, Math.min(99, Number(e.target.value) || 1)))} className="num w-28" autoFocus />}
        </Field>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={busy}>
            הוספה
          </Button>
          <Button onClick={onClose}>ביטול</Button>
        </div>
      </form>
    </Dialog>
  );
}

interface ShelfData {
  shelf: { id: string; code: string; zone: string; warehouse: string; locations: { id: string; code: string; cell: string; active: boolean }[] };
  items: { id: string; inventoryNumber: string; title: string; author: string | null; thumbAssetId: string | null }[];
}

/** The books on one shelf, with the shelf's own actions. */
function ShelfPanel({ shelfId, onClose, perms, warehouses }: { shelfId: string | null; onClose: () => void; perms: { manage: boolean; print: boolean; relocate: boolean }; warehouses: WarehouseDto[] }) {
  const router = useRouter();
  const toast = useToast();
  const print = usePrintLabels();
  const [data, setData] = useState<ShelfData | null>(null);
  const [moveBook, setMoveBook] = useState<ShelfData["items"][number] | null>(null);
  useEffect(() => {
    setData(null);
    if (!shelfId) return;
    api<ShelfData>(`/api/warehouse/shelves/${shelfId}`).then(setData).catch((e) => toast.error(errorMessage(e)));
  }, [shelfId]); // eslint-disable-line react-hooks/exhaustive-deps
  const shelf = warehouses.flatMap((w) => w.zones.flatMap((z) => z.shelves)).find((s) => s.id === shelfId);

  async function toggleActive() {
    if (!shelf) return;
    try {
      await api(`/api/warehouse/shelves/${shelf.id}`, { method: "PATCH", json: { active: !shelf.active } });
      toast.success(shelf.active ? "המדף הושבת" : "המדף הופעל");
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <>
      <Dialog open={!!shelfId} onClose={onClose} title={data ? `${data.shelf.zone} · מדף ${num(data.shelf.code)}` : "מדף"} description={data ? `${data.shelf.warehouse} · ${data.items.length} ספרים` : undefined} width="lg">
        {!data ? (
          <p className="py-6 text-center text-[13px] text-muted">טוען…</p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-2">
              {perms.print && data.shelf.locations.length > 0 && (
                <Button size="sm" icon={<Printer />} onClick={() => void print(data.shelf.locations.map((l) => ({ type: "LOCATION" as const, id: l.id })), { what: "תווית המדף" })}>
                  הדפסת תווית מדף
                </Button>
              )}
              {perms.manage && shelf && (
                <Button size="sm" icon={<Power />} onClick={toggleActive}>
                  {shelf.active ? "השבתת המדף" : "הפעלת המדף"}
                </Button>
              )}
              {data.shelf.locations[0] && (
                <Link href={`/warehouse/locations/${data.shelf.locations[0].id}`} className="inline-flex h-7.5 items-center rounded-md px-2.5 text-[13px] text-muted hover:bg-stone hover:text-ink">
                  פרטי המיקום
                </Link>
              )}
            </div>
            {data.items.length === 0 ? (
              <p className="rounded-md bg-stone px-4 py-6 text-center text-[13.5px] text-muted">אין ספרים על המדף.</p>
            ) : (
              <ul className="max-h-[50vh] divide-y divide-rule overflow-y-auto rounded-md border border-rule">
                {data.items.map((b) => (
                  <li key={b.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="block size-9 shrink-0 overflow-hidden rounded bg-stone ring-1 ring-rule">{b.thumbAssetId && <img src={`/api/assets/${b.thumbAssetId}/thumb`} alt="" loading="lazy" className="size-full object-cover" />}</span>
                    <Link href={`/inventory/${b.id}`} className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium">{b.title}</span>
                      <span className="num block font-mono text-[12px] text-muted">{b.inventoryNumber}</span>
                    </Link>
                    {perms.relocate && (
                      <IconButton label="שנה מיקום" size="sm" onClick={() => setMoveBook(b)}>
                        <ArrowLeftRight />
                      </IconButton>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Dialog>
      {moveBook && <LocationDialog open items={[moveBook]} onClose={() => setMoveBook(null)} onDone={() => setData((d) => (d ? { ...d, items: d.items.filter((i) => i.id !== moveBook.id) } : d))} />}
    </>
  );
}
