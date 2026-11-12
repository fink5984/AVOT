"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api";
import { parseUsd } from "@/lib/money";
import { CustomerPicker, type PickedCustomer } from "./customer-picker";

/** Records a sale by hand: the buyer and the hammer price. Also the late deal after the auction, and a buyer for a lot marked sold without one. */
export function RecordSaleDialog({ open, onClose, lotId, lotLabel, afterAuction }: { open: boolean; onClose: () => void; lotId: string; lotLabel: string; afterAuction?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setCustomer(null);
      setPrice("");
    }
  }, [open]);

  async function save() {
    let hammer: string | null;
    try {
      hammer = parseUsd(price);
    } catch (e) {
      return toast.error((e as Error).message);
    }
    if (!customer || !hammer) return toast.error("יש לבחור לקוח ולהזין מחיר פטיש");
    setBusy(true);
    try {
      await api("/api/sales", { method: "POST", json: { lotId, customerId: customer.id, hammerPrice: hammer, afterAuction } });
      toast.success(`נרשמה מכירה: ${lotLabel} ל${customer.name}`, { detail: "הספר לא שוחרר לליקוט. השחרור נעשה בנפרד" });
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={afterAuction ? "רישום מכירה לאחר המכרז" : "רישום מכירה"}
      description={afterAuction ? `${lotLabel} לא נמכר במכרז. העובדה הזו נשמרת לצד העסקה המאוחרת.` : lotLabel}
      footer={
        <>
          <Button onClick={onClose}>ביטול</Button>
          <Button variant="primary" loading={busy} disabled={!customer || !price.trim()} onClick={save}>
            רישום המכירה
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="קונה">{() => <CustomerPicker value={customer} onChange={setCustomer} />}</Field>
        <Field label="מחיר פטיש (דולר)">{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="למשל 800" className="w-40" />}</Field>
      </div>
    </Dialog>
  );
}
