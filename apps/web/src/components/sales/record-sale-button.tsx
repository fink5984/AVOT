"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { RecordSaleDialog } from "./record-sale-dialog";

export function RecordSaleButton({ lotId, lotLabel, afterAuction, label }: { lotId: string; lotLabel: string; afterAuction?: boolean; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <RecordSaleDialog open={open} onClose={() => setOpen(false)} lotId={lotId} lotLabel={lotLabel} afterAuction={afterAuction} />
    </>
  );
}
