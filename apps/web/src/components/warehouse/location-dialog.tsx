"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api";

interface Tree {
  id: string;
  name: string;
  zones: {
    id: string;
    name: string;
    code: string;
    shelves: { id: string; code: string; locations: { id: string; code: string; active: boolean; itemCount: number }[] }[];
  }[];
}

const num = (code: string) => (/^\d+$/.test(code) ? String(Number(code)) : code);

/**
 * "שנה מיקום": warehouse → column → shelf. Nothing is
 * typed. Works for one book or several selected books; every move is recorded in the book's history.
 */
export function LocationDialog({
  open,
  onClose,
  items,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  items: { id: string; inventoryNumber: string; title: string }[];
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [tree, setTree] = useState<Tree[] | null>(null);
  const [wh, setWh] = useState("");
  const [zone, setZone] = useState("");
  const [shelf, setShelf] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    api<{ warehouses: Tree[] }>("/api/warehouse")
      .then((r) => {
        setTree(r.warehouses);
        const first = r.warehouses[0];
        setWh((w) => w || first?.id || "");
      })
      .catch((e) => setError(errorMessage(e)));
  }, [open]);

  const warehouse = tree?.find((w) => w.id === wh);
  const column = warehouse?.zones.find((z) => z.id === zone);
  const theShelf = column?.shelves.find((s) => s.id === shelf);
  const locationId = theShelf?.locations.find((l) => l.active)?.id ?? "";

  // choosing a level resets the levels below it
  useEffect(() => setZone(""), [wh]);
  useEffect(() => setShelf(""), [zone]);

  const single = items.length === 1;
  const title = single ? `שינוי מיקום · ${items[0]!.inventoryNumber}` : `שינוי מיקום ל-${items.length} ספרים`;
  const ready = useMemo(() => !!locationId, [locationId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      if (single) {
        await api(`/api/inventory/${items[0]!.id}/location`, { method: "POST", json: { locationId } });
        toast.success("המיקום עודכן");
      } else {
        const r = await api<{ done: string[]; failed: { itemId: string; message: string }[] }>("/api/inventory/bulk-location", { method: "POST", json: { itemIds: items.map((i) => i.id), locationId } });
        if (r.failed.length) toast.warning(`${r.done.length} הועברו · ${r.failed.length} לא הועברו`, { detail: r.failed.slice(0, 2).map((f) => f.message).join(" · ") });
        else toast.success(`${r.done.length} ספרים הועברו`);
      }
      onDone?.();
      onClose();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={title} description={single ? items[0]!.title : undefined} width="sm">
      <form onSubmit={submit} className="space-y-3.5">
        {tree && tree.length === 0 && <p className="rounded-md bg-stone px-3 py-2.5 text-[13px] text-muted">עדיין לא הוגדר מחסן. אפשר להגדיר אחד במסך המחסן.</p>}
        <Field label="מחסן">
          {(p) => (
            <Select {...p} value={wh} onChange={(e) => setWh(e.target.value)}>
              {(tree ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="עמודה">
          {(p) => (
            <Select {...p} value={zone} onChange={(e) => setZone(e.target.value)} disabled={!warehouse}>
              <option value="">בחירת עמודה…</option>
              {warehouse?.zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="מדף">
          {(p) => (
            <Select {...p} value={shelf} onChange={(e) => setShelf(e.target.value)} disabled={!column}>
              <option value="">בחירת מדף…</option>
              {column?.shelves.map((s) => {
                const active = s.locations.some((l) => l.active);
                const books = s.locations.reduce((a, l) => a + l.itemCount, 0);
                return (
                  <option key={s.id} value={s.id} disabled={!active}>
                    מדף {num(s.code)} · {books} ספרים{active ? "" : " · מושבת"}
                  </option>
                );
              })}
            </Select>
          )}
        </Field>
        {error && (
          <p className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2 pt-1">
          <Button type="submit" variant="primary" loading={busy} disabled={!ready}>
            העברה
          </Button>
          <Button onClick={onClose}>ביטול</Button>
        </div>
      </form>
    </Dialog>
  );
}
