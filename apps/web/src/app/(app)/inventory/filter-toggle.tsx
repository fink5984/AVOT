"use client";

import { useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";

/** On a phone the house / review / sort selects hide behind one button so the search stays compact; from tablet up they are always shown. */
export function FilterToggle({ children, activeCount }: { children: ReactNode; activeCount: number }) {
  const [open, setOpen] = useState(activeCount > 0);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-rule-strong bg-paper px-3 text-[13px] font-medium shadow-card sm:hidden"
      >
        <SlidersHorizontal className="size-4" aria-hidden />
        סינון ומיון{activeCount > 0 && <span className="num text-accent">({activeCount})</span>}
      </button>
      <div className={cn("w-full flex-wrap items-center gap-2 sm:flex sm:w-auto", open ? "flex" : "hidden")}>{children}</div>
    </>
  );
}
