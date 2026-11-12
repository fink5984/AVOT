"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BadgeDollarSign, ChevronDown, Gavel, Home, Library, LogOut, Menu as MenuIcon, Settings, Warehouse, X } from "lucide-react";
import type { Role } from "@avot/shared";
import { Wordmark } from "@/components/brand";
import { t } from "@/i18n";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { WAREHOUSE_VIEW_ROLES } from "@/lib/nav-roles";
import { HouseSwitcher, type HouseOption } from "@/components/house-switcher";
import { GlobalSearch } from "./global-search";
import { OutboxIndicator } from "./outbox-indicator";

interface NavItem {
  href: string;
  label: string;
  roles?: Role[];
  exact?: boolean;
  /** other path prefixes that belong to this section */
  also?: string[];
}

interface NavGroup {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  items: NavItem[];
}

const ALL_BUT_WAREHOUSE: Role[] = ["ADMIN", "EDITOR", "PHOTOGRAPHER", "VIEWER"];

const HOME: NavItem & { icon: React.ComponentType<{ className?: string }> } = { href: "/", label: "לוח עבודה", icon: Home, exact: true };

/**
 * The sidebar groups. A group is shown only when at least one of its links is allowed for the role (the same role lists
 * as before the reorganisation: grouping changes the layout, never who sees what). The auction houses' catalogs are
 * added to the "catalogs" group at render time from the houses the user may access.
 */
const GROUPS: NavGroup[] = [
  {
    id: "stock",
    label: "מלאי וקליטה",
    icon: Library,
    items: [
      { href: "/inventory", label: "מלאי ספרים", also: ["/search", "/labels"] },
      { href: "/consignors", label: "מפקידים", roles: ALL_BUT_WAREHOUSE },
      { href: "/capture", label: "צילום", roles: ["ADMIN", "EDITOR", "PHOTOGRAPHER"] },
    ],
  },
  { id: "catalogs", label: "קטלוגים ומכירות", icon: Gavel, items: [] },
  {
    id: "sales",
    label: "מכירות ולקוחות",
    icon: BadgeDollarSign,
    items: [
      { href: "/sold", label: "נמכרו", roles: ["ADMIN", "EDITOR", "VIEWER"] },
      { href: "/customers", label: "לקוחות", roles: ["ADMIN", "EDITOR"] },
      { href: "/shipments", label: "משלוחים", roles: ["ADMIN", "EDITOR", "WAREHOUSE"] },
    ],
  },
  {
    id: "warehouse",
    label: "מחסן ולוגיסטיקה",
    icon: Warehouse,
    items: [
      { href: "/warehouse", label: "מחסן", roles: WAREHOUSE_VIEW_ROLES },
      // the handheld: opens the phone interface (a computer gets the explanation with links to the warehouse and inventory)
      { href: "/scanner", label: "מסופון", roles: WAREHOUSE_VIEW_ROLES },
      { href: "/scans", label: "יומן סריקות", roles: ["ADMIN", "WAREHOUSE"] },
    ],
  },
  {
    id: "system",
    label: "מערכת וניהול",
    icon: Settings,
    items: [
      { href: "/exports", label: "ייבוא וייצוא", roles: ALL_BUT_WAREHOUSE },
      { href: "/reports", label: "דוחות", roles: ["ADMIN", "EDITOR"] },
      { href: "/trash", label: "סל מחזור", roles: ["ADMIN", "EDITOR", "PHOTOGRAPHER"] },
      { href: "/settings", label: "הגדרות" },
    ],
  },
];

const CATALOGS_ROLES = ALL_BUT_WAREHOUSE;
const OPEN_KEY = "avot.nav.open";

function readOpen(): Record<string, boolean> {
  try {
    const v = JSON.parse(window.localStorage.getItem(OPEN_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

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
  // the user's own open/closed choices; a group holding the current page is always shown open
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => setNavOpen(false), [pathname]);
  useEffect(() => setChosen(readOpen()), []);
  // a page change starts at the top of the content area (the content area, not the window, is what scrolls on a computer)
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

  const under = (p: string) => pathname === p || pathname.startsWith(p + "/");
  const isActive = (item: NavItem) => (item.exact ? pathname === item.href : under(item.href) || !!item.also?.some(under));
  const allowed = (item: NavItem) => !item.roles || item.roles.includes(user.role);

  // "catalogs" group: all catalogs + one link per auction house the user may open (never the individual catalogs)
  const catalogItems: (NavItem & { color?: string })[] = CATALOGS_ROLES.includes(user.role)
    ? [
        { href: "/houses", label: "כל הקטלוגים", exact: true },
        ...houses.map((h) => ({ href: `/houses/${h.slug}`, label: h.name, color: h.color, also: h.slug === activeHouse ? ["/catalogs", "/lots"] : undefined })),
      ]
    : [];
  const groups = GROUPS.map((g) => ({ ...g, items: g.id === "catalogs" ? catalogItems : g.items.filter(allowed) })).filter((g) => g.items.length > 0);
  const groupActive = (g: { items: NavItem[] }) => g.items.some(isActive);
  const isOpen = (g: { id: string; items: NavItem[] }) => groupActive(g) || chosen[g.id] === true;
  function toggleGroup(g: { id: string; items: NavItem[] }) {
    const next = { ...chosen, [g.id]: !isOpen(g) };
    setChosen(next);
    try {
      window.localStorage.setItem(OPEN_KEY, JSON.stringify(next));
    } catch {
      /* private window: the choice just lasts for this visit */
    }
  }

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

  const HomeIcon = HOME.icon;
  const homeActive = isActive(HOME);

  return (
    // computer: one frame the height of the window; only the content area (and, when needed, the sidebar) scrolls.
    // phone / tablet: the page scrolls normally under a sticky top bar and the sidebar is a drawer.
    <div className="app-frame min-h-dvh lg:flex lg:h-dvh lg:overflow-hidden">
      <aside
        id="app-sidebar"
        className={cn(
          "no-print fixed inset-y-0 start-0 z-40 flex w-[264px] max-w-[85vw] flex-col bg-canvas transition-transform lg:static lg:z-auto lg:w-60 lg:shrink-0 lg:translate-x-0",
          navOpen ? "translate-x-0 shadow-pop" : "invisible translate-x-full lg:visible",
        )}
      >
        <div className="flex h-16 shrink-0 items-center justify-between px-5">
          <Link href="/" aria-label="לוח עבודה" className="rounded-md">
            <Wordmark size="sm" />
          </Link>
          <button className="rounded-md p-1.5 text-muted hover:bg-stone lg:hidden" onClick={() => setNavOpen(false)} aria-label="סגירת תפריט">
            <X className="size-4" />
          </button>
        </div>
        <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain px-3 pb-4 pt-2" aria-label="ניווט ראשי" data-testid="sidebar-nav">
          <Link
            href={HOME.href}
            aria-current={homeActive ? "page" : undefined}
            className={cn(
              "flex h-9 items-center gap-3 rounded-lg px-3 text-[14px] transition-colors",
              homeActive ? "bg-paper font-medium text-ink shadow-card ring-1 ring-rule" : "text-ink-2 hover:bg-stone hover:text-ink",
            )}
          >
            <HomeIcon className={cn("size-[18px] shrink-0 stroke-[1.7]", homeActive ? "text-accent" : "text-muted")} />
            {HOME.label}
          </Link>
          {groups.map((g) => {
            const open = isOpen(g);
            const active = groupActive(g);
            const Icon = g.icon;
            return (
              <div key={g.id} data-testid={`nav-group-${g.id}`}>
                <button
                  type="button"
                  onClick={() => toggleGroup(g)}
                  aria-expanded={open}
                  aria-controls={`nav-${g.id}`}
                  className={cn("flex h-9 w-full items-center gap-3 rounded-lg px-3 text-start text-[14px] transition-colors hover:bg-stone hover:text-ink", active ? "font-medium text-ink" : "text-ink-2")}
                >
                  <Icon className={cn("size-[18px] shrink-0 stroke-[1.7]", active ? "text-accent" : "text-muted")} />
                  <span className="flex-1 truncate">{g.label}</span>
                  <ChevronDown className={cn("size-4 shrink-0 text-faint transition-transform", open ? "rotate-0" : "rotate-90")} aria-hidden />
                </button>
                {open && (
                  <ul id={`nav-${g.id}`} className="mb-1 mt-0.5 space-y-0.5 ps-5">
                    {g.items.map((item) => {
                      const a = isActive(item);
                      const color = (item as { color?: string }).color;
                      return (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            aria-current={a ? "page" : undefined}
                            className={cn(
                              "flex h-8 items-center gap-2.5 rounded-md px-3 text-[13.5px] transition-colors",
                              a ? "bg-paper font-medium text-ink shadow-card ring-1 ring-rule" : "text-ink-2 hover:bg-stone hover:text-ink",
                            )}
                          >
                            {color && <span className="size-2 shrink-0 rounded-[2px]" style={{ background: color }} aria-hidden />}
                            <span className="truncate">{item.label}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </nav>
        <div className="shrink-0 border-t border-rule px-3 py-3">
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

      <div className="flex min-w-0 flex-col lg:min-h-0 lg:flex-1 lg:py-2 lg:pe-2">
        <div className="app-card flex min-w-0 flex-1 flex-col lg:min-h-0 lg:rounded-xl lg:border lg:border-rule lg:bg-[#fbfaf8] lg:shadow-card">
          <div className="no-print sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-rule/70 bg-canvas/90 px-4 backdrop-blur-md lg:static lg:rounded-t-xl lg:bg-[#fbfaf8] lg:px-8">
            <button className="rounded-md p-2 text-ink-2 hover:bg-stone lg:hidden" onClick={() => setNavOpen(true)} aria-label="פתיחת תפריט" aria-controls="app-sidebar" aria-expanded={navOpen}>
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
          {/* the one scrolling area on a computer (data-app-scroll); on a phone the window scrolls */}
          <main ref={mainRef} data-app-scroll className="min-w-0 max-w-full flex-1 overflow-x-clip lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
