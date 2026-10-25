"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}

/** Dropdown menu with roving focus (↑/↓, Home/End, Esc). */
export function Menu({
  trigger,
  items,
  align = "end",
}: {
  trigger: (props: { onClick: () => void; "aria-expanded": boolean; "aria-haspopup": "menu"; "aria-controls": string }) => React.ReactNode;
  items: (MenuItem | "separator")[];
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus());
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    const els = [...(root.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? [])];
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") els[(i + 1) % els.length]?.focus();
    else if (e.key === "ArrowUp") els[(i - 1 + els.length) % els.length]?.focus();
    else if (e.key === "Home") els[0]?.focus();
    else if (e.key === "End") els[els.length - 1]?.focus();
    else if (e.key === "Escape") setOpen(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div ref={root} className="relative inline-block" onKeyDown={onKey}>
      {trigger({ onClick: () => setOpen((o) => !o), "aria-expanded": open, "aria-haspopup": "menu", "aria-controls": id })}
      {open && (
        <div
          id={id}
          role="menu"
          className={cn(
            "animate-pop absolute top-full z-50 mt-1.5 min-w-52 rounded-lg border border-rule bg-paper p-1 shadow-pop",
            align === "end" ? "end-0" : "start-0",
          )}
        >
          {items.map((item, i) =>
            item === "separator" ? (
              <div key={i} className="-mx-1 my-1 border-t border-rule" role="separator" />
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={cn(
                  "flex h-8.5 w-full items-center gap-2.5 rounded-md px-2.5 text-start text-[13.5px] hover:bg-stone focus:bg-stone focus:outline-none disabled:opacity-40",
                  item.danger ? "text-danger [&_.menu-icon]:text-danger" : "text-ink",
                )}
              >
                <span className="menu-icon size-4 shrink-0 text-muted [&>svg]:size-4">{item.icon}</span>
                <span className="flex-1">{item.label}</span>
                {item.hint && <span className="text-[11px] text-faint">{item.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
