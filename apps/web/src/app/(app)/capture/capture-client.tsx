"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";

/** Scan field: a keyboard-wedge / USB scanner types the tag here; Enter opens the studio on that book. */
export function CaptureOpener() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = code.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ directItemId: string | null; directLotId: string | null }>(`/api/search?q=${encodeURIComponent(q)}`);
      const id = r.directItemId ?? r.directLotId;
      if (!id) {
        setError(`לא נמצא ספר עם הברקוד ${q}`);
        setCode("");
        ref.current?.focus();
        return;
      }
      router.push(`/capture/${id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card p-5">
      <label htmlFor="capture-scan" className="text-[14px] font-semibold">
        סריקת ספר לצילום
      </label>
      <p className="mt-1 text-[13px] text-muted">סרקו את התווית או הקלידו את מספר המלאי. גם תוויות קטלוג ישנות (QR) נתמכות.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input
          id="capture-scan"
          ref={ref}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
          placeholder="10000184"
          className="h-12 min-w-0 flex-1 basis-48 rounded-md border border-rule-strong bg-paper px-4 font-mono text-[18px] focus:border-ink/40 focus:outline-none focus:ring-[3px] focus:ring-ink/8"
        />
        <Button type="submit" variant="capture" size="lg" loading={busy} icon={<ScanLine />}>
          פתיחה בצילום
        </Button>
      </div>
      {error && (
        <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
