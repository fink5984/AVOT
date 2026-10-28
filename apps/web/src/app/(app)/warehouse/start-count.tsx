"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api";

/** Starts a stock count from the desktop (the phone can start one too). Entry happens on the count's own page. */
export function StartCountButton({ zones }: { zones: { id: string; name: string }[] }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [zone, setZone] = useState("");
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      const r = await api<{ count: { id: string } }>("/api/counts", { method: "POST", json: { zoneId: zone || null } });
      router.push(`/warehouse/counts/${r.count.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <>
      <Button icon={<ClipboardList />} onClick={() => setOpen(true)}>
        ספירה חדשה
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="ספירת מלאי חדשה" description="הספירה לא משנה מיקומים. הפערים נבדקים ומאושרים על ידי מנהל." width="sm">
        <Field label="מה סופרים">
          {(p) => (
            <Select {...p} value={zone} onChange={(e) => setZone(e.target.value)}>
              <option value="">כל המחסן</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="mt-5 flex gap-2">
          <Button variant="primary" loading={busy} onClick={go}>
            התחלת ספירה
          </Button>
          <Button onClick={() => setOpen(false)}>ביטול</Button>
        </div>
      </Dialog>
    </>
  );
}
