"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

export function SettingsNav({ items }: { items: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="אזורי הגדרות" className="scrollbar-none mt-5 flex gap-1 overflow-x-auto border-b border-rule">
      {items.map((item) => {
        const active = item.href === "/settings" ? pathname === "/settings" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex h-10 shrink-0 items-center whitespace-nowrap px-3 text-[13.5px] transition-colors",
              active ? "font-semibold text-ink after:absolute after:inset-x-1.5 after:-bottom-px after:h-[2px] after:rounded-full after:bg-ink" : "text-muted hover:text-ink",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
