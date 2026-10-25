import { cn } from "@/lib/cn";

/**
 * Wordmark: a rubric-red seal with the aleph, "אבות" in the display serif and a
 * small "STUDIO" tag. The serif is used for the brand only — never for UI text.
 */
export function Wordmark({ size = "md", tone = "ink", className }: { size?: "sm" | "md" | "lg"; tone?: "ink" | "light"; className?: string }) {
  const seal = size === "lg" ? "size-12 text-[28px] rounded-xl" : size === "md" ? "size-9 text-[21px] rounded-lg" : "size-8 text-[19px] rounded-lg";
  const he = size === "lg" ? "text-[34px]" : size === "md" ? "text-[24px]" : "text-[21px]";
  const en = size === "lg" ? "text-[10.5px]" : "text-[9px]";
  return (
    <div className={cn("inline-flex items-center gap-2.5 leading-none", tone === "light" ? "text-studio-text" : "text-ink", className)}>
      <span className={cn("flex shrink-0 items-center justify-center bg-accent pb-[0.08em] font-display font-bold text-white", seal)} aria-hidden>
        א
      </span>
      <span className="flex flex-col">
        <span className={cn("font-display font-bold tracking-[-0.01em]", he)}>אבות</span>
        <span className={cn("mt-0.5 font-sans font-semibold tracking-[0.28em]", en, tone === "light" ? "text-studio-muted" : "text-muted")} dir="ltr">
          STUDIO
        </span>
      </span>
    </div>
  );
}
