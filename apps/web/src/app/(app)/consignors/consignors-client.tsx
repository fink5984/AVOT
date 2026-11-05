"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Contact, Pencil, Plus } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { ConsignorDialog } from "@/components/consignors/consignor-dialog";
import type { ConsignorDto } from "@/server/services/consignors";

export function ConsignorsAddButton() {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" icon={<Plus />} onClick={() => setOpen(true)}>
        הוספת מפקיד
      </Button>
      <ConsignorDialog
        open={open}
        onClose={() => setOpen(false)}
        onSaved={(c) => {
          toast.success(`המפקיד ${c.name} נוסף`);
          router.refresh();
        }}
      />
    </>
  );
}

export function ConsignorsTable({ consignors, canManage, searching }: { consignors: ConsignorDto[]; canManage: boolean; searching: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [edit, setEdit] = useState<ConsignorDto | null>(null);

  if (consignors.length === 0) {
    return (
      <div className="card">
        <EmptyState icon={<Contact />} title={searching ? "לא נמצאו מפקידים" : "עדיין אין מפקידים"}>
          {searching ? "נסו שם, מספר טלפון או דוא״ל אחרים." : "הוסיפו מפקיד בכפתור ״הוספת מפקיד״, או ישירות בעת קליטת ספר."}
        </EmptyState>
      </div>
    );
  }

  return (
    <>
      <div className="card overflow-hidden">
        <table className="w-full text-[13.5px]">
          <thead>
            <tr className="border-b border-rule text-[12.5px] text-muted">
              <th className="px-4 py-2.5 text-start font-medium">שם</th>
              <th className="hidden px-2 py-2.5 text-start font-medium sm:table-cell">טלפון</th>
              <th className="hidden px-2 py-2.5 text-start font-medium md:table-cell">דוא״ל</th>
              <th className="w-24 px-2 py-2.5 text-start font-medium">ספרים</th>
              {canManage && <th className="w-px pe-3 ps-2 py-2.5" aria-label="פעולות" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {consignors.map((c) => (
              <tr key={c.id} className="group relative transition-colors hover:bg-stone-2">
                <td className="px-4 py-2.5">
                  <Link href={`/consignors/${c.id}`} className="font-medium text-ink after:absolute after:inset-0">
                    {c.name}
                  </Link>
                  {c.archived && (
                    <span className="ms-2 align-middle">
                      <Badge tone="neutral">בארכיון</Badge>
                    </span>
                  )}
                </td>
                <td className="num hidden px-2 py-2.5 sm:table-cell" dir="ltr">
                  <span className="block text-end">{c.phone ?? <span className="text-faint">—</span>}</span>
                </td>
                <td className="hidden px-2 py-2.5 md:table-cell" dir="ltr">
                  <span className="block truncate text-end">{c.email ?? <span className="text-faint">—</span>}</span>
                </td>
                <td className="num px-2 py-2.5">{c.bookCount}</td>
                {canManage && (
                  <td className="relative z-10 pe-3 ps-2 py-1">
                    <IconButton label={`עריכת ${c.name}`} size="sm" onClick={() => setEdit(c)}>
                      <Pencil />
                    </IconButton>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <ConsignorDialog
          open
          initial={edit}
          onClose={() => setEdit(null)}
          onSaved={(c) => {
            toast.success(`פרטי ${c.name} נשמרו`);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
