"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ConsignorDialog } from "@/components/consignors/consignor-dialog";
import { api, errorMessage } from "@/lib/api";
import type { ConsignorDto } from "@/server/services/consignors";

/** Edit, archive / restore and (only when no book was ever deposited) delete. A consignor with books is never deleted. */
export function ConsignorCardActions({ consignor }: { consignor: ConsignorDto }) {
  const router = useRouter();
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>, done: string, after?: () => void) {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      after ? after() : router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button icon={<Pencil />} onClick={() => setEdit(true)}>
        עריכה
      </Button>
      <Button
        icon={consignor.archived ? <ArchiveRestore /> : <Archive />}
        disabled={busy}
        onClick={() => {
          if (!consignor.archived && !window.confirm(`לארכב את ${consignor.name}? הספרים נשארים משויכים אליו, אך אי אפשר לשייך אליו ספרים חדשים.`)) return;
          void run(() => api(`/api/consignors/${consignor.id}`, { method: "PATCH", json: { archived: !consignor.archived } }).then(() => undefined), consignor.archived ? "המפקיד שוחזר" : "המפקיד הועבר לארכיון");
        }}
      >
        {consignor.archived ? "שחזור מארכיון" : "ארכוב"}
      </Button>
      {consignor.bookCount === 0 && (
        <Button
          icon={<Trash2 />}
          disabled={busy}
          onClick={() => {
            if (!window.confirm(`למחוק את ${consignor.name}? לא היו לו ספרים.`)) return;
            void run(() => api(`/api/consignors/${consignor.id}`, { method: "DELETE" }).then(() => undefined), "המפקיד נמחק", () => router.push("/consignors"));
          }}
        >
          מחיקה
        </Button>
      )}
      {edit && (
        <ConsignorDialog
          open
          initial={consignor}
          onClose={() => setEdit(false)}
          onSaved={(c) => {
            toast.success(`פרטי ${c.name} נשמרו`);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
