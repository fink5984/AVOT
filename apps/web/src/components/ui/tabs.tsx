"use client";

import { cn } from "@/lib/cn";

/** Tabs with arrow-key navigation (RTL aware). "line" for page sections, "pill" for compact filters. */
export function Tabs<T extends string>({
  value,
  onChange,
  items,
  className,
  variant = "line",
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: React.ReactNode; count?: number; hint?: string; adornment?: React.ReactNode }[];
  className?: string;
  variant?: "line" | "pill" | "studio";
  label?: string;
}) {
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const dir = e.key === "ArrowLeft" ? 1 : e.key === "ArrowRight" ? -1 : 0; // RTL: left = next
    if (!dir) return;
    e.preventDefault();
    const next = items[(i + dir + items.length) % items.length]!;
    onChange(next.value);
    (e.currentTarget.parentElement?.children[(i + dir + items.length) % items.length] as HTMLElement | undefined)?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "scrollbar-none flex max-w-full items-stretch overflow-x-auto",
        variant === "line" && "gap-1 border-b border-rule",
        variant === "pill" && "gap-0.5 rounded-lg bg-stone p-0.5",
        variant === "studio" && "gap-0.5",
        className,
      )}
    >
      {items.map((item, i) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={item.hint}
            onClick={() => onChange(item.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              "relative flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[13.5px] transition-colors",
              variant === "line" &&
                (active
                  ? "h-10 px-3 font-semibold text-ink after:absolute after:inset-x-1.5 after:-bottom-px after:h-[2px] after:rounded-full after:bg-ink"
                  : "h-10 px-3 text-muted hover:text-ink"),
              variant === "pill" &&
                (active ? "h-8 rounded-md bg-paper px-3 font-medium text-ink shadow-card" : "h-8 rounded-md px-3 text-muted hover:text-ink"),
              variant === "studio" &&
                (active
                  ? "h-9 rounded-md bg-studio-text px-3 font-semibold text-studio"
                  : "h-9 rounded-md px-3 text-studio-muted hover:bg-studio-3 hover:text-studio-text"),
            )}
          >
            {item.label}
            {item.count !== undefined && (
              <span
                className={cn(
                  "num min-w-5 rounded-full px-1.5 text-center text-[11.5px] leading-5",
                  active ? (variant === "studio" ? "bg-studio/10" : "bg-stone text-ink-2") : variant === "pill" ? "text-faint" : "bg-stone-2 text-muted",
                )}
              >
                {item.count}
              </span>
            )}
            {item.adornment}
          </button>
        );
      })}
    </div>
  );
}
