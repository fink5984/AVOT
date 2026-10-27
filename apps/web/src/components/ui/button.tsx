import { forwardRef } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "accent" | "capture" | "studio";
type Size = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-100 select-none active:translate-y-px disabled:opacity-45 disabled:pointer-events-none [&_svg]:shrink-0";

const variants: Record<Variant, string> = {
  primary: "bg-ink text-paper shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] hover:bg-[#2d2b28]",
  secondary: "bg-paper text-ink border border-rule-strong shadow-card hover:bg-stone-2 hover:border-[#c6c2b8]",
  ghost: "text-ink-2 hover:bg-stone hover:text-ink",
  danger: "bg-paper text-danger border border-danger/35 hover:bg-danger-soft",
  accent: "bg-green text-paper hover:bg-green-2",
  /** the one action that starts photographing */
  capture: "bg-accent text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.14)] hover:bg-accent-2",
  studio: "bg-studio-3 text-studio-text border border-studio-rule hover:bg-[#2c2c30]",
};

const sizes: Record<Size, string> = {
  sm: "h-7.5 px-2.5 text-[13px] [&_svg]:size-3.5",
  md: "h-9 px-3.5 text-[13.5px] [&_svg]:size-4",
  lg: "h-11 px-5 text-[14.5px] [&_svg]:size-4.5",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(base, variants[variant], sizes[size], className)}
      {...rest}
    >
      {loading ? <Loader2 className="animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export function ButtonLink({
  href,
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
  prefetch,
  ...rest
}: { href: string; variant?: Variant; size?: Size; icon?: React.ReactNode; prefetch?: boolean } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  // API routes (downloads, redirects to signed URLs) need a real navigation, not client routing
  if (href.startsWith("/api/")) {
    return (
      <a href={href} className={cn(base, variants[variant], sizes[size], className)} {...rest}>
        {icon}
        {children}
      </a>
    );
  }
  return (
    <Link href={href} prefetch={prefetch} className={cn(base, variants[variant], sizes[size], className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}

export function IconButton({
  label,
  className,
  variant = "ghost",
  size = "md",
  children,
  ...rest
}: { label: string; variant?: Variant; size?: Size } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const dim = size === "sm" ? "size-7.5" : size === "lg" ? "size-11" : "size-9";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(base, variants[variant], dim, "px-0 [&_svg]:size-4", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Icon-only link with the IconButton look (tooltip + accessible name from `label`). */
export function IconButtonLink({
  href,
  label,
  className,
  size = "sm",
  children,
}: {
  href: string;
  label: string;
  className?: string;
  size?: Size;
  children: React.ReactNode;
}) {
  const dim = size === "sm" ? "size-7.5" : size === "lg" ? "size-11" : "size-9";
  return (
    <Link href={href} aria-label={label} title={label} className={cn(base, variants.ghost, dim, "px-0 [&_svg]:size-4", className)}>
      {children}
    </Link>
  );
}
