"use client";

import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";

export interface HouseOption {
  slug: string;
  name: string;
  color: string;
}

/** Remembers the chosen house for the next visit (UI preference only — the server checks access on every request). */
export function rememberHouse(slug: string) {
  document.cookie = `avot_house=${encodeURIComponent(slug)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

/**
 * Auction-house switcher (אבות / טבין). Switching changes which house's
 * catalogs and commercial data are shown; the shared inventory is unaffected.
 */
export function HouseSwitcher({ houses, active, compact = false }: { houses: HouseOption[]; active: string | null; compact?: boolean }) {
  const router = useRouter();
  if (houses.length < 2) return null;
  return (
    <div role="radiogroup" aria-label="בית מכירות" className={cn("inline-flex items-stretch gap-0.5 rounded-lg bg-stone p-0.5", compact && "h-8")}>
      {houses.map((h) => {
        const on = h.slug === active;
        return (
          <button
            key={h.slug}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => {
              rememberHouse(h.slug);
              router.push(`/houses/${h.slug}`);
            }}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors",
              compact ? "h-7" : "h-8",
              on ? "bg-paper text-ink shadow-card ring-1 ring-rule" : "text-ink-2 hover:text-ink",
            )}
          >
            <span className="size-2 rounded-[2px]" style={{ background: h.color }} aria-hidden />
            {h.name}
          </button>
        );
      })}
    </div>
  );
}
