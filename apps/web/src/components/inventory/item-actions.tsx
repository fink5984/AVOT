"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { BookUp, Camera, Gavel, Library, MapPin, MoreHorizontal, PackageOpen, Pencil, Printer, Tag, Trash2 } from "lucide-react";
import type { CommercialStatus, PhysicalStatus } from "@avot/shared";
import { IconButton, IconButtonLink } from "@/components/ui/button";
import { Menu, type MenuItem } from "@/components/ui/menu";
import { useToast } from "@/components/ui/toast";
import { AssignDialog } from "@/components/inventory/assign-dialog";
import { ItemFormDialog, type ItemFormValue } from "@/components/inventory/item-form-dialog";
import { LocationDialog } from "@/components/warehouse/location-dialog";
import { DeleteDialog } from "@/components/deletion/delete-dialog";
import { api, errorMessage } from "@/lib/api";
import { usePrintLabels } from "@/lib/print";

export interface ItemActionsSubject {
  id: string;
  inventoryNumber: string;
  title: string;
  physicalStatus: PhysicalStatus;
  commercialStatus: CommercialStatus;
  hasLocation: boolean;
  /** null: not assigned · "active": assigned to a catalog the user can see · "hidden": another house */
  assignment: "active" | "hidden" | null;
  hasOpenPick?: boolean;
  /** where the camera icon goes (default: the capture screen of this book) */
  captureHref?: string;
  /** full details; only the book page passes it, and only there is "עריכה" offered */
  edit?: ItemFormValue;
}

export interface ItemActionsPerms {
  capture: boolean;
  label: boolean;
  assign: boolean;
  relocate: boolean;
  edit?: boolean;
  fulfil?: boolean;
  delete?: boolean;
  pick?: boolean;
}

/** The same service as the phone scanner's "הוצאה זמנית / הוצאה סופית", also used by the bulk bar of the table. */
export function useItemCheckout() {
  const router = useRouter();
  const toast = useToast();
  return useCallback(
    async (kind: "TEMP" | "FINAL", ids: string[], after?: () => void) => {
      if (kind === "FINAL" && !window.confirm(`הוצאה סופית של ${ids.length} ספרים? הם יסומנו כנשלחו. פעולה זו אפשרית רק לספרים שנמכרו.`)) return;
      try {
        const r = await api<{ done: string[]; skipped: { itemId: string; message: string }[] }>("/api/inventory/bulk-checkout", { method: "POST", json: { itemIds: ids, kind } });
        if (r.skipped.length) toast.warning(`${r.done.length} הוצאו · ${r.skipped.length} לא`, { detail: r.skipped.slice(0, 2).map((s) => s.message).join(" · ") });
        else toast.success(kind === "TEMP" ? (ids.length === 1 ? "הספר הוצא זמנית — יש להחזירו למדף" : `${r.done.length} ספרים הוצאו זמנית — יש להחזירם למדף`) : `${r.done.length} ספרים הוצאו סופית`);
        after?.();
        router.refresh();
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
    [router, toast],
  );
}

/**
 * The one set of per-book actions, in the inventory table and at the top of the book page: photograph,
 * print the label (one click, the shop's printer), assign to a catalog, change location (warehouse → column →
 * shelf), edit, and the rest in a menu. Same logic and same permissions everywhere; only the density differs.
 */
export function InventoryItemActions({ subject, perms, context }: { subject: ItemActionsSubject; perms: ItemActionsPerms; context: "table" | "page" }) {
  const router = useRouter();
  const toast = useToast();
  const print = usePrintLabels();
  const checkout = useItemCheckout();
  const [assign, setAssign] = useState(false);
  const [move, setMove] = useState(false);
  const [edit, setEdit] = useState(false);
  const [del, setDel] = useState(false);
  const [printing, setPrinting] = useState(false);
  const size = context === "table" ? "sm" : "md";
  const sold = subject.commercialStatus === "SOLD" || subject.physicalStatus === "SHIPPED";

  async function printLabel() {
    if (printing) return; // a double click never queues two labels
    setPrinting(true);
    try {
      await print([{ type: "BOOK", id: subject.id }], { what: `תווית ${subject.inventoryNumber}` });
    } finally {
      setTimeout(() => setPrinting(false), 600);
    }
  }

  async function requestPick() {
    const reason = window.prompt("סיבת ההוצאה מהמחסן (למשל: צילום חוזר, תצוגה, נמכר מחוץ לקטלוג)");
    if (!reason?.trim()) return;
    try {
      await api(`/api/inventory/${subject.id}/pick`, { method: "POST", json: { reason: reason.trim() } });
      toast.success("נוצרה משימת ליקוט");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const menu: (MenuItem | "separator")[] = [];
  if (context === "table") menu.push({ label: "פתיחה והיסטוריה", icon: <Library />, onSelect: () => router.push(`/inventory/${subject.id}`) });
  if (perms.label) menu.push({ label: "תווית להדפסה ידנית (PDF / ZPL)", icon: <Tag />, onSelect: () => router.push(`/labels/books?ids=${subject.id}`) });
  if (perms.relocate && subject.hasLocation) menu.push({ label: "הוצאה זמנית מהמדף", icon: <BookUp />, onSelect: () => void checkout("TEMP", [subject.id]) });
  if (perms.fulfil && subject.commercialStatus === "SOLD") menu.push({ label: "הוצאה סופית (נשלח)", icon: <BookUp />, onSelect: () => void checkout("FINAL", [subject.id]) });
  if (context === "page" && perms.pick && !subject.hasOpenPick && subject.physicalStatus !== "SHIPPED") menu.push({ label: "משימת ליקוט ידנית", icon: <PackageOpen />, onSelect: () => void requestPick() });
  if (perms.delete) {
    if (menu.length) menu.push("separator");
    menu.push({ label: "מחיקה לצמיתות", icon: <Trash2 />, danger: true, onSelect: () => setDel(true) });
  }

  return (
    <>
      <div className="flex items-center gap-0.5" role="group" aria-label={`פעולות לספר ${subject.inventoryNumber}`}>
        {perms.capture && (
          <IconButtonLink href={subject.captureHref ?? `/capture/${subject.id}`} label={`צילום ${subject.inventoryNumber}`} size={size}>
            <Camera className="text-accent" />
          </IconButtonLink>
        )}
        {perms.label && (
          <IconButton label={`הדפסת תווית ${subject.inventoryNumber}`} size={size} disabled={printing} onClick={() => void printLabel()}>
            <Printer />
          </IconButton>
        )}
        {perms.assign && !sold && (
          <IconButton label={subject.assignment ? "שינוי שיוך לקטלוג" : "שייך לקטלוג"} size={size} onClick={() => setAssign(true)}>
            <Gavel />
          </IconButton>
        )}
        {perms.relocate && (
          <IconButton label="שנה מיקום" size={size} onClick={() => setMove(true)}>
            <MapPin />
          </IconButton>
        )}
        {context === "page" && perms.edit && subject.edit && (
          <IconButton label="עריכת פרטי הספר" size={size} onClick={() => setEdit(true)}>
            <Pencil />
          </IconButton>
        )}
        {menu.length > 0 && (
          <Menu
            trigger={(p) => (
              <IconButton label={`פעולות נוספות ל-${subject.inventoryNumber}`} size={size} {...p}>
                <MoreHorizontal />
              </IconButton>
            )}
            items={menu}
          />
        )}
      </div>
      {assign && <AssignDialog open onClose={() => setAssign(false)} items={[{ id: subject.id, inventoryNumber: subject.inventoryNumber, title: subject.title }]} />}
      {move && <LocationDialog open onClose={() => setMove(false)} items={[{ id: subject.id, inventoryNumber: subject.inventoryNumber, title: subject.title }]} />}
      {edit && subject.edit && <ItemFormDialog open onClose={() => setEdit(false)} initial={subject.edit} />}
      {del && <DeleteDialog kind="books" open ids={[subject.id]} onClose={() => setDel(false)} onDone={() => (context === "page" ? router.push("/inventory") : router.refresh())} />}
    </>
  );
}
