"use client";

import { useEffect, useRef, useState } from "react";
import { ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { api, errorMessage } from "@/lib/api";

interface SearchResult {
  directItemId: string | null;
  directLotId: string | null;
}

/**
 * "Open a book by scanning its tag". The scan goes into a focused text input,
 * so a keyboard-wedge scanner's keystrokes never reach the studio's shortcuts
 * (digits switch categories, Space is the shutter).
 */
export function ScanOpenDialog({
  open,
  onClose,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  /** item id or lot id */
  onOpen: (targetId: string) => void | Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setCode("");
    setError(null);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = code.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<SearchResult>(`/api/search?q=${encodeURIComponent(q)}`);
      const id = r.directItemId ?? r.directLotId;
      if (!id) {
        setError(`לא נמצא ספר עם הברקוד ${q}`);
        setCode("");
        input.current?.focus();
        return;
      }
      await onOpen(id);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="פתיחת ספר בסריקה" description="סרקו את תווית הספר (ITM-…) או הקלידו את מספר המלאי ולחצו Enter." width="sm">
      <form onSubmit={submit} className="flex gap-2">
        <input
          ref={input}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
          aria-label="ברקוד ספר"
          placeholder="10000184"
          className="h-10 min-w-0 flex-1 rounded-md border border-rule-strong bg-paper px-3 font-mono text-[15px] focus:outline-none focus:ring-[3px] focus:ring-ink/10"
        />
        <Button type="submit" variant="primary" loading={busy} icon={<ScanLine />}>
          פתיחה
        </Button>
      </form>
      {error && (
        <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
