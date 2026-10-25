"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Native <dialog> — focus trapping, Esc to close and inert background come
 * from the browser. Keeps the component tiny and accessible.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = "md",
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  width?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  const widths = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        "m-auto w-[calc(100%-2rem)] rounded-xl border border-rule bg-paper p-0 text-ink shadow-pop open:animate-pop",
        widths[width],
        className,
      )}
      aria-labelledby="dialog-title"
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-start justify-between gap-4 px-6 pb-2 pt-5">
            <div>
              <h2 id="dialog-title" className="text-[17px] font-semibold tracking-[-0.01em]">
                {title}
              </h2>
              {description && <p className="mt-1 text-[13px] leading-relaxed text-muted">{description}</p>}
            </div>
            <button type="button" onClick={onClose} className="-me-2 -mt-1 rounded-md p-1.5 text-muted hover:bg-stone hover:text-ink" aria-label="סגירה">
              <X className="size-4" />
            </button>
          </header>
          <div className="overflow-y-auto px-6 pb-6 pt-3">{children}</div>
          {footer && <footer className="flex items-center justify-start gap-2 border-t border-rule bg-stone-2 px-6 py-3.5">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
