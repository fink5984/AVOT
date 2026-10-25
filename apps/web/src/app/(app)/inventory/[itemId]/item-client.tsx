"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Gavel, MapPin, MoreHorizontal, PackageOpen, Pencil, Tag } from "lucide-react";
import type { CommercialStatus, PhysicalStatus } from "@avot/shared";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { Menu, type MenuItem } from "@/components/ui/menu";
import { useToast } from "@/components/ui/toast";
import { AssignDialog } from "@/components/inventory/assign-dialog";
import { ItemFormDialog, type ItemFormValue } from "@/components/inventory/item-form-dialog";
import { api, errorMessage } from "@/lib/api";

interface ItemActionsProps {
  item: ItemFormValue & {
    id: string;
    inventoryNumber: string;
    physicalStatus: PhysicalStatus;
    commercialStatus: CommercialStatus;
    hasActiveLot: boolean;
    hasOpenPick: boolean;
  };
  perms: { edit: boolean; assign: boolean; label: boolean; pick: boolean; move: boolean };
}

export function ItemActions({ item, perms }: ItemActionsProps) {
  const router = useRouter();
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const [assign, setAssign] = useState(false);
  const [move, setMove] = useState(false);
  const sold = item.commercialStatus === "SOLD" || item.physicalStatus === "SHIPPED";

  async function requestPick() {
    const reason = window.prompt("סיבת ההוצאה מהמחסן (למשל: צילום חוזר, תצוגה, נמכר מחוץ לקטלוג)");
    if (!reason?.trim()) return;
    try {
      await api(`/api/inventory/${item.id}/pick`, { method: "POST", json: { reason: reason.trim() } });
      toast.success("נוצרה משימת ליקוט");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const items: (MenuItem | "separator")[] = [];
  if (perms.edit) items.push({ label: "עריכת פרטי הספר", icon: <Pencil />, onSelect: () => setEdit(true) });
  if (perms.move) items.push({ label: "תיקון מיקום במחסן", icon: <MapPin />, onSelect: () => setMove(true) });
  if (perms.pick && !item.hasOpenPick && item.physicalStatus !== "SHIPPED") items.push({ label: "משימת ליקוט ידנית", icon: <PackageOpen />, onSelect: () => void requestPick() });

  return (
    <>
      {perms.label && (
        <Button icon={<Tag />} onClick={() => router.push(`/labels/books?ids=${item.id}`)}>
          תווית ברקוד
        </Button>
      )}
      {perms.assign && !sold && (
        <Button icon={<Gavel />} onClick={() => setAssign(true)}>
          {item.hasActiveLot ? "שינוי שיוך" : "שייך לקטלוג"}
        </Button>
      )}
      {items.length > 0 && (
        <Menu
          trigger={(p) => (
            <IconButton label="פעולות נוספות" {...p}>
              <MoreHorizontal />
            </IconButton>
          )}
          items={items}
        />
      )}
      {edit && <ItemFormDialog open onClose={() => setEdit(false)} initial={item} />}
      {assign && <AssignDialog open onClose={() => setAssign(false)} items={[{ id: item.id, inventoryNumber: item.inventoryNumber, title: item.title }]} />}
      {move && <MoveDialog itemId={item.id} onClose={() => setMove(false)} />}
    </>
  );
}

interface Suggestion {
  id: string;
  code: string;
  label: string;
  items: number;
  capacity: number | null;
  exactSize: boolean;
}

/** Manager correction of a location (handheld scans are the normal path). Suggests places by size and capacity. */
function MoveDialog({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  useEffect(() => {
    api<{ suggestions: Suggestion[] }>(`/api/inventory/${itemId}/location`)
      .then((r) => setSuggestions(r.suggestions))
      .catch(() => undefined);
  }, [itemId]);

  async function save(locationCode: string | null) {
    setBusy(true);
    try {
      let locationId: string | null = null;
      if (locationCode) locationId = (await api<{ location: { id: string } }>(`/api/warehouse/locations?code=${encodeURIComponent(locationCode)}`)).location.id;
      await api(`/api/inventory/${itemId}/location`, { method: "POST", json: { locationId, note: note || null } });
      toast.success(locationCode ? `המיקום עודכן ל-${locationCode.toUpperCase()}` : "המיקום הוסר");
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="תיקון מיקום במחסן" description="התיקון נרשם בהיסטוריית התנועות. בעבודה שוטפת מעדכנים מיקום בסריקה במסופון." width="sm">
      <div className="space-y-4">
        <Field label="קוד מיקום">
          {(p) => <Input {...p} value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" placeholder="LOC-A-03-02" className="font-mono" autoFocus />}
        </Field>
        {suggestions.length > 0 && (
          <div>
            <div className="mb-1.5 text-[12.5px] font-medium text-muted">הצעות לפי גודל ומקום פנוי</div>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((s) => (
                <button key={s.id} type="button" onClick={() => setCode(s.code)} className="rounded-md bg-stone px-2.5 py-1 text-[12.5px] hover:bg-stone-2" title={s.label}>
                  <span className="num font-mono">{s.code}</span>
                  <span className="ms-1.5 text-muted">
                    {s.items}
                    {s.capacity ? `/${s.capacity}` : ""}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        <Field label="הערה">
          {(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}
        </Field>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button variant="primary" loading={busy} disabled={!code.trim()} onClick={() => save(code.trim())}>
          עדכון מיקום
        </Button>
        <Button variant="danger" loading={busy} onClick={() => save(null)}>
          הסרת מיקום
        </Button>
        <Button onClick={onClose}>ביטול</Button>
      </div>
    </Dialog>
  );
}
