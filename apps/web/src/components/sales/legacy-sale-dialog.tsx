"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api";
import { CustomerPicker, type PickedCustomer } from "./customer-picker";

/** One short confirmation: no price, catalog, lot number or buyer is asked for. */
export function LegacySaleDialog({ open, onClose, itemId }: { open: boolean; onClose: () => void; itemId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function confirm() {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/api/inventory/${itemId}/legacy-sale`, { method: "POST" });
      toast.success("הספר סומן כנמכר במערכת הישנה");
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
      title="סימון ספר כנמכר במערכת הישנה"
      footer={
        <>
          <Button onClick={onClose}>ביטול</Button>
          <Button variant="primary" loading={busy} onClick={() => void confirm()}>
            אישור - סמן כנמכר
          </Button>
        </>
      }
    >
      <p className="text-[14px] leading-relaxed">הספר נמכר במכירה קודמת שנוהלה מחוץ למערכת AVOT. הוא יועבר לדף 'נמכרו' ויוסר מרשימת המלאי הפעיל. אם הוא עדיין נמצא במחסן, ניתן יהיה להמשיך בליקוט ובמשלוח שלו.</p>
    </Dialog>
  );
}

/** Attach the buyer of a legacy sale afterwards (an existing customer or a new one). */
export function AttachBuyerDialog({ open, onClose, purchaseId }: { open: boolean; onClose: () => void; purchaseId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!customer || busy) return;
    setBusy(true);
    try {
      await api(`/api/purchases/${purchaseId}/legacy`, { method: "PATCH", json: { customerId: customer.id } });
      toast.success("הלקוח שויך למכירה");
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
      title="שיוך לקוח למכירה ישנה"
      description="אין חובה לשייך לקוח. אחרי השיוך הספר יופיע בדף הלקוח ויוכל להצטרף למשלוח."
      footer={
        <>
          <Button onClick={onClose}>ביטול</Button>
          <Button variant="primary" loading={busy} disabled={!customer} onClick={() => void save()}>
            שיוך הלקוח
          </Button>
        </>
      }
    >
      <Field label="לקוח">{() => <CustomerPicker value={customer} onChange={setCustomer} />}</Field>
    </Dialog>
  );
}

/** Takes the mark back (marked by mistake). Needs a reason; refused by the server once the book has left. */
export function UnmarkLegacyDialog({ open, onClose, purchaseId }: { open: boolean; onClose: () => void; purchaseId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/api/purchases/${purchaseId}/legacy`, { method: "DELETE", json: { reason } });
      toast.success("הסימון בוטל והספר חזר למלאי הפעיל");
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
      title="ביטול סימון מכירה ישנה"
      description="הרישום נשמר בהיסטוריה. משימות ליקוט והמיקום במחסן לא ישתנו."
      footer={
        <>
          <Button onClick={onClose}>סגירה</Button>
          <Button variant="primary" loading={busy} disabled={reason.trim().length < 2} onClick={() => void save()}>
            ביטול הסימון
          </Button>
        </>
      }
    >
      <Field label="סיבה">{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="למשל: סומן בטעות" />}</Field>
    </Dialog>
  );
}

/** buttons of a legacy sale on the book page */
export function LegacySaleControls({ purchaseId, canAttach, canUnmark, hasBuyer }: { purchaseId: string; canAttach: boolean; canUnmark: boolean; hasBuyer: boolean }) {
  const [attach, setAttach] = useState(false);
  const [unmark, setUnmark] = useState(false);
  return (
    <div className="flex flex-wrap gap-1.5">
      {canAttach && (
        <Button size="sm" onClick={() => setAttach(true)}>
          {hasBuyer ? "החלפת לקוח" : "שיוך לקוח"}
        </Button>
      )}
      {canUnmark && (
        <Button size="sm" onClick={() => setUnmark(true)}>
          ביטול סימון (נסמן בטעות)
        </Button>
      )}
      {attach && <AttachBuyerDialog open onClose={() => setAttach(false)} purchaseId={purchaseId} />}
      {unmark && <UnmarkLegacyDialog open onClose={() => setUnmark(false)} purchaseId={purchaseId} />}
    </div>
  );
}
