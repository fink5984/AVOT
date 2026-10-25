import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/cn";

export function PageHeader({
  title,
  eyebrow,
  meta,
  actions,
  breadcrumbs,
  className,
  children,
}: {
  title: React.ReactNode;
  eyebrow?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumbs?: { label: string; href?: string }[];
  className?: string;
  /** extra content under the title row (status bar, tabs…) */
  children?: React.ReactNode;
}) {
  return (
    <header className={cn("px-4 pb-5 pt-5 lg:px-8 lg:pt-7", className)}>
      {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
      <div className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-4", breadcrumbs && "mt-2")}>
        <div className="min-w-0">
          {eyebrow && <div className="mb-1.5 text-[13px] font-medium text-muted">{eyebrow}</div>}
          <h1 className="text-balance text-[26px] font-semibold leading-[1.15] tracking-[-0.02em]">{title}</h1>
          {meta && <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-muted">{meta}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

/** Content area under a PageHeader — consistent gutters on every screen. */
export function PageBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("px-4 pb-10 lg:px-8", className)}>{children}</div>;
}

export function Breadcrumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="נתיב" className="flex flex-wrap items-center gap-1 text-[13px] text-muted">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronLeft className="size-3.5 text-faint" aria-hidden />}
          {item.href ? (
            <Link href={item.href} className="rounded-sm px-0.5 hover:text-ink">
              {item.label}
            </Link>
          ) : (
            <span className="px-0.5 text-ink-2">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-16 text-center", className)}>
      {icon && <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-stone text-muted [&>svg]:size-5.5 [&>svg]:stroke-[1.6]">{icon}</div>}
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      {children && <div className="mt-1.5 max-w-md text-[13.5px] leading-relaxed text-muted">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("card overflow-hidden", className)}>
      {(title || actions) && (
        <div className="flex min-h-12 items-center justify-between gap-3 border-b border-rule px-5 py-2.5">
          {title && <h2 className="text-[14px] font-semibold text-ink">{title}</h2>}
          {actions && <div className="flex items-center gap-1.5">{actions}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-rule-strong bg-paper px-1 font-mono text-[10.5px] text-ink-2 shadow-[0_1px_0_var(--color-rule-strong)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-md", className)} aria-hidden />;
}

export function Stat({
  label,
  value,
  sub,
  href,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  href?: string;
  tone?: "danger" | "info" | "green" | "warn" | "accent";
}) {
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-muted">
        {tone && <span className={cn("size-1.5 rounded-full", { danger: "bg-danger", info: "bg-info", green: "bg-green", warn: "bg-warn", accent: "bg-accent" }[tone])} aria-hidden />}
        {label}
      </div>
      <div className="num mt-1.5 text-start text-[26px] font-semibold leading-none tracking-[-0.02em] text-ink">{value}</div>
      {sub && <div className="mt-1.5 text-[12px] text-muted">{sub}</div>}
    </>
  );
  return href ? (
    <Link href={href} className="block rounded-lg px-5 py-4 transition-colors hover:bg-stone-2">
      {body}
    </Link>
  ) : (
    <div className="px-5 py-4">{body}</div>
  );
}

/** Thin horizontal progress bar. */
export function Progress({
  value,
  max,
  tone = "green",
  className,
}: {
  value: number;
  max: number;
  tone?: "green" | "accent" | "ink";
  className?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-stone", className)} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div
        className={cn("h-full rounded-full transition-[width] duration-500", tone === "green" ? "bg-green" : tone === "accent" ? "bg-accent" : "bg-ink")}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
