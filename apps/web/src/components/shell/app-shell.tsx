"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BarChart3, Camera, Download, Gavel, Home, Library, LogOut, Menu as MenuIcon, ScanLine, Settings, Trash2, Warehouse, X } from "lucide-react";
import type { Role } from "@avot/shared";
import { Wordmark } from "@/components/brand";
import { t } from "@/i18n";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { HouseSwitcher, type HouseOption } from "@/components/house-switcher";
import { GlobalSearch } from "./global-search";
import { OutboxIndicator } from "./outbox-indicator";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles?: Role[];
  exact?: boolean;
  /** other path prefixes that belong to this section */
  also?: string[];
}

const ALL_BUT_WAREHOUSE: Role[] = ["ADMIN", "EDITOR", "PHOTOGRAPHER", "VIEWER"];

const MAIN: NavItem[] = [
  { href: "/", label: "סקירה כללית", icon: Home, exact: true },
  { href: "/inventory", label: "מלאי", icon: Library, also: ["/search"] },
  { href: "/capture", label: "צילום", icon: Camera, roles: ["ADMIN", "EDITOR", "PHOTOGRAPHER"] },
  { href: "/warehouse", label: "מחסן", icon: Warehouse, roles: ["ADMIN", "EDITOR", "WAREHOUSE", "VIEWER"] },
  { href: "/scans", label: "סריקות", icon: ScanLine, roles: ["ADMIN", "WAREHOUSE"] },
  { href: "/houses", label: "בתי מכירות", icon: Gavel, roles: ALL_BUT_WAREHOUSE, exact: true },
];

const TOOLS: NavItem[] = [
  { href: "/exports", label: "הורדות", icon: Download, roles: ALL_BUT_WAREHOUSE },
  { href: "/reports", label: "דוחות", icon: BarChart3, roles: ["ADMIN", "EDITOR"] },
  { href: "/trash", label: "סל מחזור", icon: Trash2, roles: ["ADMIN", "EDITOR", "PHOTOGRAPHER"] },
];

const SETTINGS: NavItem = { href: "/settings", label: "הגדרות", icon: Settings };

export function AppShell({
  user,
  houses = [],
  activeHouse = null,
  children,
}: {
  user: { userId: string; name: string; role: Role; email: string };
  houses?: HouseOption[];
  activeHouse?: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => setNavOpen(false), [pathname]);

  const under = (p: string) => pathname === p || pathname.startsWith(p + "/");
  const isActive = (item: NavItem) => (item.exact ? pathname === item.href : under(item.href) || !!item.also?.some(under));

  const NavLink = ({ item }: { item: NavItem }) => {
    const Icon = item.icon;
    const active = isActive(item);
    return (
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-9 items-center gap-3 rounded-lg px-3 text-[14px] transition-colors",
          active ? "bg-paper font-medium text-ink shadow-card ring-1 ring-rule" : "text-ink-2 hover:bg-stone hover:text-ink",
        )}
      >
        <Icon className={cn("size-[18px] shrink-0 stroke-[1.7]", active ? "text-accent" : "text-muted")} />
        {item.label}
      </Link>
    );
  };

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  const initials = user.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("");

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[240px_1fr]">
      <aside
        className={cn(
          "no-print fixed inset-y-0 start-0 z-40 flex w-[264px] flex-col bg-canvas transition-transform lg:sticky lg:top-0 lg:h-dvh lg:w-auto lg:translate-x-0",
          navOpen ? "translate-x-0 shadow-pop" : "invisible translate-x-full lg:visible",
        )}
      >
        <div className="flex h-16 items-center justify-between px-5">
          <Link href="/" aria-label="לוח עבודה" className="rounded-md">
            <Wordmark size="sm" />
          </Link>
          <button className="rounded-md p-1.5 text-muted hover:bg-stone lg:hidden" onClick={() => setNavOpen(false)} aria-label="סגירת תפריט">
            <X className="size-4" />
          </button>
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-4 pt-2" aria-label="ניווט ראשי">
          {MAIN.filter((i) => !i.roles || i.roles.includes(user.role)).map((item) => (
            <div key={item.href}>
              <NavLink item={item} />
              {item.href === "/houses" && houses.length > 0 && (
                <div className="mt-0.5 flex flex-col gap-0.5 ps-6">
                  {houses.map((h) => {
                    const active = under(`/houses/${h.slug}`) || (h.slug === activeHouse && (under("/catalogs") || under("/lots")));
                    return (
                      <Link
                        key={h.slug}
                        href={`/houses/${h.slug}`}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex h-8 items-center gap-2.5 rounded-md px-3 text-[13.5px] transition-colors",
                          active ? "bg-paper font-medium text-ink ring-1 ring-rule" : "text-ink-2 hover:bg-stone hover:text-ink",
                        )}
                      >
                        <span className="size-2 rounded-[2px]" style={{ background: h.color }} aria-hidden />
                        {h.name}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
          {TOOLS.some((i) => !i.roles || i.roles.includes(user.role)) && <div className="mt-4 px-3 pb-1 text-[11.5px] font-medium text-faint">כלים</div>}
          {TOOLS.filter((i) => !i.roles || i.roles.includes(user.role)).map((item) => (
            <NavLink key={item.href} item={item} />
          ))}
          <div className="mt-auto pt-4">
            <NavLink item={SETTINGS} />
          </div>
        </nav>
        <div className="border-t border-rule px-3 py-3">
          <div className="flex items-center gap-3 px-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-[12px] font-semibold text-paper" aria-hidden>
              {initials}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-medium">{user.name}</div>
              <div className="truncate text-[12px] text-muted">{t.role[user.role]}</div>
            </div>
            <button onClick={logout} className="rounded-md p-2 text-muted hover:bg-stone hover:text-ink" aria-label="יציאה" title="יציאה">
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>
      {navOpen && <div className="fixed inset-0 z-30 bg-black/30 backdrop-blur-[1px] lg:hidden" onClick={() => setNavOpen(false)} aria-hidden />}

      <div className="flex min-w-0 flex-col lg:py-2 lg:pe-2">
        <div className="flex min-w-0 flex-1 flex-col lg:rounded-xl lg:border lg:border-rule lg:bg-[#fbfaf8] lg:shadow-card">
          <div className="no-print sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-rule/70 bg-canvas/90 px-4 backdrop-blur-md lg:rounded-t-xl lg:bg-[#fbfaf8]/90 lg:px-8">
            <button className="rounded-md p-2 text-ink-2 hover:bg-stone lg:hidden" onClick={() => setNavOpen(true)} aria-label="פתיחת תפריט">
              <MenuIcon className="size-5" />
            </button>
            <GlobalSearch />
            <div className="ms-auto flex items-center gap-2">
              {houses.length > 1 && (
                <div className="hidden md:block">
                  <HouseSwitcher houses={houses} active={activeHouse} compact />
                </div>
              )}
              <OutboxIndicator userId={user.userId} />
            </div>
          </div>
          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </div>
    </div>
  );
}
