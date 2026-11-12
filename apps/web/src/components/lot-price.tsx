"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatUsd, parseUsd } from "@/lib/money";

/**
 * The lot's starting price (USD), edited in place: click, type, Enter (or leave the field) to save, Esc to cancel.
 * Empty = no price (never 0). On an error or a conflict with another person's edit the last saved value comes back.
 */
export function LotPriceCell({
  lotId,
  price,
  version,
  canEdit,
  className,
  size = "md",
}: {
  lotId: string;
  price: string | null;
  version: number;
  canEdit: boolean;
  className?: string;
  size?: "md" | "lg";
}) {
  const router = useRouter();
  const toast = useToast();
  const [saved, setSaved] = useState({ price, version });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "ok">("idle");
  const input = useRef<HTMLInputElement>(null);

  // the server's data is the truth: a refresh brings the newest price and version
  useEffect(() => setSaved({ price, version }), [price, version]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  async function commit() {
    if (state === "saving") return;
    const text = draft.trim();
    let next: string | null;
    try {
      next = parseUsd(text);
    } catch (e) {
      toast.error((e as Error).message);
      setEditing(false);
      return;
    }
    if (next === saved.price) {
      setEditing(false);
      return;
    }
    setState("saving");
    try {
      const r = await api<{ startingPrice: string | null; priceVersion: number }>(`/api/lots/${lotId}/price`, { method: "PATCH", json: { price: next, expectedVersion: saved.version } });
      setSaved({ price: r.startingPrice, version: r.priceVersion });
      setState("ok");
      setTimeout(() => setState("idle"), 1600);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFLICT" && (err.details as { code?: string } | undefined)?.code === "PRICE_CONFLICT") {
        const d = err.details as { current: string | null; version: number };
        setSaved({ price: d.current, version: d.version });
      }
      toast.error(errorMessage(err));
      setState("idle");
    }
    setEditing(false);
  }

  const text = formatUsd(saved.price);
  const big = size === "lg";
  if (!canEdit) {
    return <span className={cn("num", !saved.price && "text-faint", className)}>{text}</span>;
  }
  if (editing) {
    return (
      <span className={cn("inline-flex items-center gap-1", className)}>
        <span className="text-faint" aria-hidden>
          $
        </span>
        <input
          ref={input}
          autoFocus
          dir="ltr"
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={() => void commit()}
          aria-label="מחיר פתיחה בדולרים"
          placeholder="ללא מחיר"
          className={cn("w-24 rounded-md border border-ink bg-paper px-2 text-end outline-none ring-2 ring-accent/30", big ? "h-10 text-lg" : "h-8 text-[13.5px]")}
        />
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        setDraft(saved.price ? (saved.price.endsWith(".00") ? saved.price.slice(0, -3) : saved.price) : "");
        setEditing(true);
      }}
      title="לחיצה לעריכת מחיר הפתיחה"
      className={cn(
        "num inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-start hover:bg-stone focus-visible:outline-2 focus-visible:outline-accent",
        big && "min-h-11 text-lg font-semibold",
        !saved.price && "text-faint",
        className,
      )}
    >
      {text}
      {state === "ok" && <Check className="size-3.5 text-green" aria-label="נשמר" />}
      {state === "saving" && <span className="text-[11px] text-muted">שומר…</span>}
    </button>
  );
}
